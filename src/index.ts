import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getChatModel,
  setChatModel,
  getChatShowThinking,
  setChatShowThinking,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { ChannelType } from './text-styles.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Channel,
  ModelOverride,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import {
  getAvailableModelAliases,
  loadModelConfigs,
  resolveModelAlias,
} from './model-router.js';
import {
  ipcFolderName,
  makeSlotKey,
  parseSlotKey,
  sessionKey,
} from './slot-key.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(slotKey: string): string {
  const existing = lastAgentTimestamp[slotKey];
  if (existing) return existing;

  const { chatJid, modelKey } = parseSlotKey(slotKey);
  const botTs = getLastBotMessageTimestamp(chatJid, modelKey || ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { slotKey, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[slotKey] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** @internal */
export async function processGroupMessages(slotKey: string): Promise<boolean> {
  const { chatJid, modelKey } = parseSlotKey(slotKey);
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // Capture the default model at the start of the run to ensure deterministic routing
  // for all messages currently in the batch, even if a session command changes it mid-run.
  const initialSavedAlias = getChatModel(chatJid) || undefined;

  while (true) {
    const missedMessages = getMessagesSince(
      chatJid,
      getOrRecoverCursor(slotKey),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );

    if (missedMessages.length === 0) return true;

    // --- Slot Routing check ---
    // Skip processing if the message is clearly intended for a different agent slot.
    // For main groups, this prevents multiple slots (aliases) from processing the same untagged message.
    const lastUserMsg = [...missedMessages]
      .reverse()
      .find((m) => !m.is_from_me);

    if (isMainGroup && lastUserMsg) {
      const alias = resolveModelAlias(lastUserMsg.content, group.trigger);
      if (alias && alias !== 'unknown-alias') {
        if (alias.config.alias !== modelKey) {
          logger.debug(
            { group: group.name, slotKey, alias: alias.config.alias },
            'Skipping slot: message intended for another alias',
          );
          return true;
        }
      } else {
        // Message has NO explicit alias. It's intended for the default agent,
        // which could be a saved alias (captured at start of run) or the system default.
        if (modelKey !== initialSavedAlias) {
          logger.debug(
            { group: group.name, slotKey, initialSavedAlias },
            'Skipping slot: message without alias (not intended for this slot)',
          );
          return true;
        }
      }
    }

    // --- Session command interception ---
    const currentSavedAlias = getChatModel(chatJid) || undefined;
    const cmdResult = await handleSessionCommand({
      missedMessages,
      isMainGroup,
      groupName: group.name,
      triggerPattern: getTriggerPattern(group.trigger),
      timezone: TIMEZONE,
      deps: {
        sendMessage: (text) =>
          sendMessageAndStore(chatJid, text, ASSISTANT_NAME),
        setTyping: (typing) =>
          channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
        runAgent: (prompt, onOutput) =>
          runAgent(group, prompt, chatJid, onOutput, modelKey),
        closeStdin: () => queue.closeStdin(slotKey),
        advanceCursor: (ts) => {
          lastAgentTimestamp[slotKey] = ts;
          saveState();
        },
        formatMessages,
        canSenderInteract: (msg) => {
          const hasTrigger = getTriggerPattern(group.trigger).test(
            msg.content.trim(),
          );
          const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
          return (
            isMainGroup ||
            !reqTrigger ||
            (hasTrigger &&
              (msg.is_from_me ||
                isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
          );
        },
        getAvailableModelAliases,
        chatJid,
        getChatModel,
        setChatModel,
        getChatShowThinking,
        setChatShowThinking,
      },
      modelKey,
    });

    if (cmdResult.handled) {
      if (!cmdResult.success) return false;

      // If the command changed the default model, we MUST stop and re-enqueue
      // for the new slots to ensure remaining messages are routed correctly.
      const newSavedAlias = getChatModel(chatJid) || undefined;
      if (newSavedAlias !== currentSavedAlias) {
        logger.info(
          { chatJid, old: currentSavedAlias, new: newSavedAlias },
          'Default model changed, re-enqueuing affected slots',
        );
        queue.enqueueMessageCheck(chatJid);
        if (newSavedAlias) {
          queue.enqueueMessageCheck(makeSlotKey(chatJid, newSavedAlias));
        }
        return true;
      }

      continue; // Check for more messages (could be more commands or regular messages)
    }
    // --- End session command interception ---

    // For non-main groups, check if trigger is required and present.
    // A known model alias also acts as an implicit trigger.
    // Only user messages (not bot messages) trigger the LLM to avoid feedback loops.
    if (!isMainGroup && group.requiresTrigger !== false) {
      const triggerPattern = getTriggerPattern(group.trigger);
      const allowlistCfg = loadSenderAllowlist();
      let hasTrigger = missedMessages.some(
        (m) =>
          !m.is_from_me &&
          triggerPattern.test(m.content.trim()) &&
          isTriggerAllowed(chatJid, m.sender, allowlistCfg),
      );
      if (!hasTrigger) {
        hasTrigger = missedMessages.some((m) => {
          if (m.is_from_me) return false;
          const r = resolveModelAlias(m.content, group.trigger);
          return r !== null && r !== 'unknown-alias';
        });
      }
      if (!hasTrigger) return true;
    } else if (isMainGroup) {
      // For main groups, we already performed the alias check above.
      // Just ensure there's at least one user message to trigger the agent.
      const hasUserMessage = missedMessages.some((m) => !m.is_from_me);
      if (!hasUserMessage) return true;
    }

    // Derive the model override from the slot's modelKey (set by startMessageLoop routing).
    // Alias detection and stripping already happened before enqueue, but we re-fetch
    // here, so we must re-strip to ensure the container doesn't see the trigger word.
    const configs = loadModelConfigs();
    const modelConfig = modelKey
      ? configs.find((c) => c.alias === modelKey)
      : undefined;

    if (modelConfig) {
      const lastMsg = missedMessages[missedMessages.length - 1];
      const r = resolveModelAlias(lastMsg.content, group.trigger);
      if (r && r !== 'unknown-alias' && r.config.alias === modelKey) {
        lastMsg.content = r.strippedPrompt;
      }
    }

    const prompt = formatMessages(missedMessages, TIMEZONE);

    // Advance cursor so the piping path in startMessageLoop won't re-fetch
    // these messages. Save the old cursor so we can roll back on error.
    const previousCursor = lastAgentTimestamp[slotKey] || '';
    lastAgentTimestamp[slotKey] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();

    logger.info(
      { group: group.name, messageCount: missedMessages.length },
      'Processing messages',
    );

    // Track idle timer for closing stdin when agent is idle
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        queue.closeStdin(slotKey);
      }, IDLE_TIMEOUT);
    };

    await channel.setTyping?.(chatJid, true);
    let hadError = false;
    let outputSentToUser = false;

    const output = await runAgent(
      group,
      prompt,
      chatJid,
      async (result) => {
        // Streaming output callback — called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const senderName = modelKey || ASSISTANT_NAME;
          logger.info(
            { group: group.name },
            `Agent output: ${raw.length} chars`,
          );
          if (raw.trim()) {
            const showThinking = getChatShowThinking(chatJid);
            if (!result.isIntermediate || showThinking) {
              await sendMessageAndStore(chatJid, raw, senderName);
              outputSentToUser = true;
            }
          }
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();
        }

        if (result.status === 'success') {
          queue.notifyIdle(slotKey);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
      modelKey,
    );

    await channel.setTyping?.(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      // If we already sent output to the user, don't roll back the cursor —
      // the user got their response and re-processing would send duplicates.
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }

      // Roll back cursor so retries can re-process these messages
      lastAgentTimestamp[slotKey] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    return true; // Processed one batch, let GroupQueue handle any remaining
  }
}

/**
 * Send a message to a chat and store it in the database for future context.
 */
async function sendMessageAndStore(
  chatJid: string,
  text: string,
  senderName: string,
  threadId?: string,
): Promise<void> {
  try {
    logger.debug(
      { chatJid, senderName, textLength: text.length },
      'sendMessageAndStore called',
    );
    const channel = findChannel(channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, cannot send message');
      return;
    }
    const formatted = formatOutbound(text, channel.name as ChannelType);
    if (!formatted) return;

    await channel.sendMessage(chatJid, formatted, threadId);

    // Ensure chat metadata exists before storing message (FK safety)
    storeChatMetadata(chatJid, new Date().toISOString());

    storeMessage({
      id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      chat_jid: chatJid,
      sender: 'bot',
      sender_name: senderName,
      content: formatted,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
      thread_id: threadId,
    });
  } catch (err) {
    logger.error({ chatJid, senderName, err }, 'Failed in sendMessageAndStore');
  }
}

/** @internal */
export async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  modelKey?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const slotKey = makeSlotKey(chatJid, modelKey);
  const sessKey = sessionKey(group.folder, modelKey);
  const sessionId = sessions[sessKey];

  // Derive model override from modelKey
  const configs = loadModelConfigs();
  const modelConfig = modelKey
    ? configs.find((c) => c.alias === modelKey)
    : undefined;
  const modelOverride: ModelOverride | undefined = modelConfig
    ? { baseUrl: modelConfig.baseUrl, model: modelConfig.model }
    : undefined;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
    modelKey,
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
    modelKey,
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[sessKey] = output.newSessionId;
          setSession(sessKey, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        modelOverride,
        modelKey,
      },
      (proc, containerName) =>
        queue.registerProcess(
          slotKey,
          proc,
          containerName,
          ipcFolderName(group.folder, modelKey),
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessKey] = output.newSessionId;
      setSession(sessKey, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[sessKey];
        deleteSession(sessKey);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          let loopCmdSlotKey = chatJid;
          const loopCmdMsg = groupMessages.find((m) => {
            // Check default trigger
            const defaultCmd = extractSessionCommand(
              m.content,
              getTriggerPattern(group.trigger),
            );
            if (defaultCmd !== null) {
              if (
                defaultCmd === '/compact' ||
                defaultCmd === '/models' ||
                defaultCmd === '/model' ||
                defaultCmd.startsWith('/model ')
              ) {
                const savedAlias = getChatModel(chatJid);
                loopCmdSlotKey = savedAlias
                  ? makeSlotKey(chatJid, savedAlias)
                  : chatJid;
                return true;
              }
            }
            // Check all known aliases
            const aliasResult = resolveModelAlias(m.content, group.trigger);
            if (aliasResult && aliasResult !== 'unknown-alias') {
              const stripped = aliasResult.strippedPrompt;
              if (
                stripped === '/compact' ||
                stripped === '/models' ||
                stripped === '/model' ||
                stripped.startsWith('/model ')
              ) {
                loopCmdSlotKey = makeSlotKey(chatJid, aliasResult.config.alias);
                return true;
              }
            }
            return false;
          });

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(loopCmdSlotKey);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(loopCmdSlotKey);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = group.requiresTrigger !== false;

          // Only user messages (not bot messages) trigger the LLM to avoid feedback loops.
          const hasUserMessage = groupMessages.some((m) => !m.is_from_me);
          if (!hasUserMessage) continue;

          // For non-main groups, only act on trigger messages.
          if (!isMainGroup && needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            let hasTrigger = groupMessages.some(
              (m) =>
                !m.is_from_me &&
                triggerPattern.test(m.content.trim()) &&
                isTriggerAllowed(chatJid, m.sender, allowlistCfg),
            );
            if (!hasTrigger) {
              hasTrigger = groupMessages.some((m) => {
                if (m.is_from_me) return false;
                const r = resolveModelAlias(m.content, group.trigger);
                return r !== null && r !== 'unknown-alias';
              });
            }
            if (!hasTrigger) continue;
          }

          // Check the last message for a model alias before routing.
          // Unknown aliases get an error reply without spawning a container.
          const lastMsgInBatch = groupMessages[groupMessages.length - 1];
          const loopAliasResult = resolveModelAlias(
            lastMsgInBatch.content,
            group.trigger,
          );

          if (loopAliasResult === 'unknown-alias') {
            const aliases = getAvailableModelAliases();
            const errorMsg =
              aliases.length > 0
                ? `Unknown model alias. Available: ${aliases.map((a) => '@' + a).join(', ')}`
                : 'No model aliases configured. Add entries to models.yaml.';
            try {
              await sendMessageAndStore(chatJid, errorMsg, ASSISTANT_NAME);
            } catch (err) {
              logger.warn(
                { chatJid, err },
                'Failed to send unknown-alias error',
              );
            }
            lastAgentTimestamp[chatJid] = lastMsgInBatch.timestamp;
            saveState();
            continue;
          }

          // Compute the slotKey now that we know if it's an alias.
          // If no explicit alias is provided, check for a saved default model for this chat.
          let slotKey = chatJid;
          if (loopAliasResult) {
            slotKey = makeSlotKey(chatJid, loopAliasResult.config.alias);
          } else {
            const savedAlias = getChatModel(chatJid);
            if (savedAlias) {
              slotKey = makeSlotKey(chatJid, savedAlias);
            }
          }

          // Pull all messages since this slot's lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const currentCursor = getOrRecoverCursor(slotKey);
          const allPending = getMessagesSince(
            chatJid,
            currentCursor,
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Strip alias prefix before formatting so the container doesn't see "@gemma"
          if (loopAliasResult) {
            const lastMsg = messagesToSend[messagesToSend.length - 1];
            // Only strip if it matches the content we just resolved
            if (lastMsg.content.includes(loopAliasResult.config.alias)) {
              lastMsg.content = loopAliasResult.strippedPrompt;
            }
          }

          const effectiveFormatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(slotKey, effectiveFormatted)) {
            logger.debug(
              { chatJid, slotKey, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[slotKey] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container for this slot — enqueue for a new one
            queue.enqueueMessageCheck(slotKey);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Check default slot
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }

    // Check all known alias slots for this group
    const modelAliases = loadModelConfigs();
    for (const aliasCfg of modelAliases) {
      const slotKey = makeSlotKey(chatJid, aliasCfg.alias);
      const aliasPending = getMessagesSince(
        chatJid,
        getOrRecoverCursor(slotKey),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (aliasPending.length > 0) {
        logger.info(
          {
            group: group.name,
            alias: aliasCfg.alias,
            pendingCount: aliasPending.length,
          },
          'Recovery: found unprocessed messages for alias',
        );
        queue.enqueueMessageCheck(slotKey);
      }
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  const modelAliases = loadModelConfigs();
  logger.info({ count: modelAliases.length }, 'Model aliases loaded');

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await sendMessageAndStore(chatJid, result.url, ASSISTANT_NAME);
      } else {
        await sendMessageAndStore(
          chatJid,
          `Remote Control failed: ${result.error}`,
          ASSISTANT_NAME,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await sendMessageAndStore(
          chatJid,
          'Remote Control session ended.',
          ASSISTANT_NAME,
        );
      } else {
        await sendMessageAndStore(chatJid, result.error, ASSISTANT_NAME);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: (jid, rawText) =>
      sendMessageAndStore(jid, rawText, ASSISTANT_NAME),
  });
  startIpcWatcher({
    sendMessage: (jid, rawText) =>
      sendMessageAndStore(jid, rawText, ASSISTANT_NAME),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
