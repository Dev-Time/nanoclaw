/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  isIntermediate?: boolean;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Only pass model when CLAUDE_CODE_MODEL is set (alias slots only).
  // Default slot omits it so the SDK uses its own model resolution.
  const modelOverride = process.env.CLAUDE_CODE_MODEL || undefined;

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      model: modelOverride,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__ollama__*',
        'mcp__seats_aero__*',
        'mcp__brave__*',
        'mcp__parallel-search__*',
        'mcp__parallel-task__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ollama: {
          command: 'node',
          args: [path.join(path.dirname(mcpServerPath), 'ollama-mcp-stdio.js')],
        },
        ...(process.env.BRAVE_API_KEY
          ? {
              brave: {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-brave-search'],
                env: {
                  BRAVE_API_KEY: process.env.BRAVE_API_KEY,
                },
              },
            }
          : {}),
        ...(fs.existsSync('/workspace/seats-aero-mcp')
          ? {
              seats_aero: {
                command: 'sh',
                args: [
                  '-c',
                  `mkdir -p "${process.env.SEATS_AERO_DATA_DIR || '/home/node/.claude/seats-aero-data'}" "${process.env.SEATS_AERO_LOG_DIR || '/home/node/.claude/seats-aero-logs'}" && cd /workspace/seats-aero-mcp && poetry install --no-interaction --no-root && poetry run python src/mcp_server.py`,
                ],
                env: {
                  SEATS_AERO_API_KEY: process.env.SEATS_AERO_API_KEY || '',
                  SEATS_AERO_DATA_DIR:
                    process.env.SEATS_AERO_DATA_DIR ||
                    '/home/node/.claude/seats-aero-data',
                  SEATS_AERO_LOG_DIR:
                    process.env.SEATS_AERO_LOG_DIR ||
                    '/home/node/.claude/seats-aero-logs',
                },
              },
            }
          : {}),
        ...(process.env.PARALLEL_API_KEY
          ? {
              'parallel-search': {
                type: 'http' as const,
                url: 'https://search-mcp.parallel.ai/mcp',
                headers: {
                  Authorization: `Bearer ${process.env.PARALLEL_API_KEY}`,
                },
              },
              'parallel-task': {
                type: 'http' as const,
                url: 'https://task-mcp.parallel.ai/mcp',
                headers: {
                  Authorization: `Bearer ${process.env.PARALLEL_API_KEY}`,
                },
              },
            }
          : {}),
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant') {
      if ('uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      const contentBlocks = (message as any).message?.content;
      if (Array.isArray(contentBlocks)) {
        const thoughts: string[] = [];
        for (const block of contentBlocks) {
          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            thoughts.push(`🤔 *Thinking*\n${block.thinking}`);
          } else if (block.type === 'text' && typeof block.text === 'string') {
            const match = block.text.match(/<think>([\s\S]*?)<\/think>/);
            if (match) {
              thoughts.push(`🤔 *Thinking*\n${match[1].trim()}`);
            }
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            thoughts.push(`🛠️ *Tool Call: ${block.name}*`);
          }
        }

        if (thoughts.length > 0) {
          writeOutput({
            status: 'success',
            result: thoughts.join('\n\n'),
            newSessionId,
            isIntermediate: true,
          });
        }
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      let textResult =
        'result' in message ? (message as { result?: string }).result : null;

      // Prevent duplication of thinking blocks in final result
      if (textResult) {
        textResult = textResult.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }

      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      writeOutput({
        status: 'success',
        result: (textResult || null) as string | null,
        newSessionId,
      });
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

const apiTimeoutMs = parseInt(process.env.API_TIMEOUT_MS || '1200000', 10);

const keepAliveAgent = new http.Agent({ keepAlive: true, timeout: apiTimeoutMs });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, timeout: apiTimeoutMs });

/**
 * Start a local proxy that intercepts non-streaming completion requests,
 * forces streaming upstream to prevent timeouts, and buffers the result
 * into a single non-streaming response for the SDK.
 */
async function startStreamingProxy(upstreamUrl: string, port: number): Promise<void> {
  const url = new URL(upstreamUrl);
  const upstreamHost = url.hostname;
  const upstreamPort = url.port || (url.protocol === 'https:' ? '443' : '80');
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  const client = protocol === 'https' ? https : http;
  const agent = protocol === 'https' ? keepAliveHttpsAgent : keepAliveAgent;

  const server = http.createServer(async (req, res) => {
    log(`[proxy] ${req.method} ${req.url}`);

    if (req.method !== 'POST' || !req.url || (!req.url.includes('/chat/completions') && !req.url.includes('/api/generate') && !req.url.includes('/api/chat') && !req.url.includes('/v1/messages'))) {
      log(`[proxy] Passing through (unsupported method or URL): ${req.method} ${req.url}`);
      // Forward everything else as-is
      forwardRequest(req, res, protocol, upstreamHost, upstreamPort, upstreamUrl);
      return;
    }

    // Intercept completion requests
    let bodyData = '';
    req.on('data', chunk => { bodyData += chunk; });
    req.on('end', async () => {
      let body: any;
      try {
        body = JSON.parse(bodyData);
      } catch (err) {
        log(`[proxy] Passing through (non-JSON body): ${req.method} ${req.url}`);
        // Not JSON, just forward
        forwardRequest(req, res, protocol, upstreamHost, upstreamPort, upstreamUrl, bodyData);
        return;
      }

      // If already streaming, just forward
      if (body.stream === true) {
        log(`[proxy] Already streaming: ${req.url}`);
        forwardRequest(req, res, protocol, upstreamHost, upstreamPort, upstreamUrl, bodyData);
        return;
      }

      // Force streaming
      log(`[proxy] Forcing stream: true for ${req.url}`);
      body.stream = true;
      const modifiedBody = JSON.stringify(body);

      const upstreamReq = client.request({
        hostname: upstreamHost,
        port: parseInt(upstreamPort),
        path: req.url,
        method: 'POST',
        agent: agent,
        timeout: apiTimeoutMs,
        headers: {
          ...req.headers,
          'host': upstreamHost,
          'content-length': Buffer.byteLength(modifiedBody),
          'accept': 'text/event-stream, application/x-ndjson',
        }
      }, (upstreamRes) => {
        if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
          log(`[proxy] Upstream error status: ${upstreamRes.statusCode} for ${req.url}`);
        }
        const contentType = upstreamRes.headers['content-type'] || '';
        let fullContent = '';
        let lastResponse: any = null;

        upstreamRes.on('data', (chunk) => {
          const text = chunk.toString();
          let tokensCountBefore = fullContent.split(/\s+/).length;
          
          if (contentType.includes('text/event-stream')) {
            // OpenAI SSE format
            const lines = text.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                  const json = JSON.parse(data);
                  const content = json.choices?.[0]?.delta?.content || (json.type === 'content_block_delta' ? json.delta?.text : '') || '';
                  fullContent += content;
                  lastResponse = json;
                } catch {}
              }
            }
          } else {
            // Assume NDJSON (Ollama native)
            const lines = text.split('\n');
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const json = JSON.parse(line);
                fullContent += json.message?.content || json.response || '';
                lastResponse = json;
              } catch {}
            }
          }

          let tokensCountAfter = fullContent.split(/\s+/).length;
          if (Math.floor(tokensCountAfter / 50) > Math.floor(tokensCountBefore / 50)) {
            log(`[proxy] Buffering progress: ~${tokensCountAfter} words received...`);
          }
        });

        upstreamRes.on('end', () => {
          if (!lastResponse) {
            log(`[proxy] Error: Upstream returned no data for ${req.url}`);
            res.writeHead(upstreamRes.statusCode || 500);
            res.end('Upstream error or empty response');
            return;
          }

          // Build a single non-streaming response
          let finalResponse: any;
          if (req.url?.includes('/v1/chat/completions')) {
            finalResponse = {
              ...lastResponse,
              choices: [{
                ...lastResponse.choices?.[0],
                message: {
                  role: 'assistant',
                  content: fullContent,
                },
                delta: undefined,
                finish_reason: lastResponse.choices?.[0]?.finish_reason || 'stop',
              }],
              object: 'chat.completion',
            };
          } else if (req.url?.includes('/v1/messages')) {
            // Anthropic format
            finalResponse = {
              ...lastResponse,
              type: 'message',
              content: [{ type: 'text', text: fullContent }],
              stop_reason: 'end_turn',
            };
          } else {
            // Ollama native
            finalResponse = {
              ...lastResponse,
              response: fullContent,
              message: lastResponse.message ? { ...lastResponse.message, content: fullContent } : undefined,
              done: true,
            };
          }

          const responseBody = JSON.stringify(finalResponse);
          log(`[proxy] Buffered response complete for ${req.url} (${Buffer.byteLength(responseBody)} bytes)`);
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(responseBody),
          });
          res.end(responseBody);
        });
      });

      upstreamReq.on('error', (err) => {
        log(`[proxy] Upstream request error: ${err.message}`);
        res.writeHead(500);
        res.end(`Proxy error: ${err.message}`);
      });

      upstreamReq.setTimeout(apiTimeoutMs, () => {
        log('[proxy] Upstream request timeout');
        upstreamReq.destroy();
      });

      upstreamReq.write(modifiedBody);
      upstreamReq.end();
    });
  });

  server.timeout = apiTimeoutMs;
  server.headersTimeout = apiTimeoutMs;
  server.requestTimeout = apiTimeoutMs;
  server.keepAliveTimeout = apiTimeoutMs;

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      log(`[proxy] Streaming proxy listening on 127.0.0.1:${port}`);
      resolve();
    });
    server.on('error', reject);
  });
}

/**
 * Transparently forward a request to the upstream server.
 */
function forwardRequest(req: http.IncomingMessage, res: http.ServerResponse, protocol: string, host: string, port: string, baseUrl: string, body?: string) {
  const client = protocol === 'https' ? https : http;
  const agent = protocol === 'https' ? keepAliveHttpsAgent : keepAliveAgent;
  const options = {
    hostname: host,
    port: parseInt(port),
    path: req.url,
    method: req.method,
    agent: agent,
    timeout: apiTimeoutMs,
    headers: {
      ...req.headers,
      'host': host,
    },
  };

  const upstreamReq = client.request(options, (upstreamRes) => {
    log(`[proxy] Forward response: ${upstreamRes.statusCode} for ${req.url}`);
    res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (err) => {
    log(`[proxy] Forward error: ${err.message}`);
    res.writeHead(500);
    res.end(`Proxy forward error: ${err.message}`);
  });

  upstreamReq.setTimeout(apiTimeoutMs, () => {
    log('[proxy] Forward request timeout');
    upstreamReq.destroy();
  });

  if (body) {
    upstreamReq.write(body);
    upstreamReq.end();
  } else {
    req.pipe(upstreamReq);
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.COMPACT_WINDOW || '100000',
    API_TIMEOUT_MS: String(apiTimeoutMs),
    NO_PROXY: 'localhost,127.0.0.1,host.docker.internal',
    no_proxy: 'localhost,127.0.0.1,host.docker.internal',
  };

  // Start streaming proxy if enabled for this host
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const proxyEnabledHosts = (process.env.STREAMING_PROXY_ENABLED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean);
  
  if (originalBaseUrl && proxyEnabledHosts.length > 0) {
    const isEnabled = proxyEnabledHosts.some(h => originalBaseUrl.includes(h));
    if (isEnabled) {
      log(`[proxy] Streaming proxy enabled for host: ${originalBaseUrl}`);
      try {
        const proxyPort = 11435;
        await startStreamingProxy(originalBaseUrl, proxyPort);
        sdkEnv.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}`;
      } catch (err) {
        log(`[proxy] Failed to start streaming proxy: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // --- Slash command handling ---
  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(trimmedPrompt);

  if (isSessionSlashCommand) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
        options: {
          cwd: '/workspace/group',
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          env: sdkEnv,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'] as const,
          hooks: {
            PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          },
        },
      })) {
        const msgType = message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          compactBoundarySeen = true;
          log('Compact boundary observed — compaction completed');
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult = 'result' in message ? (message as { result?: string }).result : null;

          if (resultSubtype?.startsWith('error')) {
            hadError = true;
            writeOutput({
              status: 'error',
              result: null,
              error: textResult || 'Session command failed.',
              newSessionId: slashSessionId,
            });
          } else {
            writeOutput({
              status: 'success',
              result: textResult || 'Conversation compacted.',
              newSessionId: slashSessionId,
            });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    log(`Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`);

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log('WARNING: compact_boundary was not observed. Compaction may not have completed.');
    }

    // Only emit final session marker if no result was emitted yet and no error occurred
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen
          ? 'Conversation compacted.'
          : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({ status: 'success', result: null, newSessionId: slashSessionId });
    }
    return;
  }
  // --- End slash command handling ---

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
