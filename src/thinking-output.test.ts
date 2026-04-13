import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  CLAUDE_CODE_MODEL: 'claude-3-sonnet-20240229',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  OLLAMA_ADMIN_TOOLS: false,
  ONECLI_URL: 'http://localhost:10254',
  SEATS_AERO_API_KEY: undefined,
  SEATS_AERO_LOG_DIR: undefined,
  SEATS_AERO_DATA_DIR: undefined,
  BRAVE_API_KEY: undefined,
  PARALLEL_API_KEY: undefined,
  STREAMING_PROXY_ENABLED_HOSTS: undefined,
  API_TIMEOUT_MS: 1200000,
  COMPACT_WINDOW: 100000,
  MAX_RETRIES: 5,
  BASE_RETRY_MS: 5000,
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
    },
  };
});

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: any,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner intermediate thinking output', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('correctly handles multiple output markers for thinking and result', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // 1. Emit thinking block
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: '🤔 *Thinking*\nI should check the weather.',
    });
    await vi.advanceTimersByTimeAsync(10);

    // 2. Emit tool call block
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: '🛠️ *Tool Call: get_weather*',
    });
    await vi.advanceTimersByTimeAsync(10);

    // 3. Emit final result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'The weather is sunny.',
      newSessionId: 'session-789',
    });
    await vi.advanceTimersByTimeAsync(10);

    // 4. Emit query completion (null result)
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-789',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Final close
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-789');

    // Verify all markers were passed to onOutput
    expect(onOutput).toHaveBeenCalledTimes(4);
    expect(onOutput).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        result: '🤔 *Thinking*\nI should check the weather.',
      }),
    );
    expect(onOutput).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ result: '🛠️ *Tool Call: get_weather*' }),
    );
    expect(onOutput).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ result: 'The weather is sunny.' }),
    );
    expect(onOutput).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ result: null }),
    );
  });
});
