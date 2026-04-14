import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'OLLAMA_ADMIN_TOOLS',
  'ONECLI_URL',
  'TZ',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_MODEL',
  'SEATS_AERO_API_KEY',
  'SEATS_AERO_LOG_DIR',
  'SEATS_AERO_DATA_DIR',
  'BRAVE_API_KEY',
  'PARALLEL_API_KEY',
  'STREAMING_PROXY_ENABLED_HOSTS',
  'POLL_INTERVAL',
  'SCHEDULER_POLL_INTERVAL',
  'IPC_POLL_INTERVAL',
  'CONTAINER_TIMEOUT',
  'IDLE_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'API_TIMEOUT_MS',
  'COMPACT_WINDOW',
  'MAX_RETRIES',
  'BASE_RETRY_MS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const OLLAMA_ADMIN_TOOLS =
  (process.env.OLLAMA_ADMIN_TOOLS || envConfig.OLLAMA_ADMIN_TOOLS) === 'true';
export const STREAMING_PROXY_ENABLED_HOSTS =
  process.env.STREAMING_PROXY_ENABLED_HOSTS ||
  envConfig.STREAMING_PROXY_ENABLED_HOSTS ||
  'ollama,host.docker.internal';
export const POLL_INTERVAL = parseInt(
  process.env.POLL_INTERVAL || envConfig.POLL_INTERVAL || '2000',
  10,
);
export const SCHEDULER_POLL_INTERVAL = parseInt(
  process.env.SCHEDULER_POLL_INTERVAL ||
    envConfig.SCHEDULER_POLL_INTERVAL ||
    '60000',
  10,
);

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || envConfig.CONTAINER_TIMEOUT || '3600000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE ||
    envConfig.CONTAINER_MAX_OUTPUT_SIZE ||
    '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ANTHROPIC_BASE_URL =
  process.env.ANTHROPIC_BASE_URL || envConfig.ANTHROPIC_BASE_URL;
export const CLAUDE_CODE_MODEL =
  process.env.CLAUDE_CODE_MODEL || envConfig.CLAUDE_CODE_MODEL;
export const SEATS_AERO_API_KEY =
  process.env.SEATS_AERO_API_KEY || envConfig.SEATS_AERO_API_KEY;
export const SEATS_AERO_LOG_DIR =
  process.env.SEATS_AERO_LOG_DIR || envConfig.SEATS_AERO_LOG_DIR;
export const SEATS_AERO_DATA_DIR =
  process.env.SEATS_AERO_DATA_DIR || envConfig.SEATS_AERO_DATA_DIR;
export const BRAVE_API_KEY =
  process.env.BRAVE_API_KEY || envConfig.BRAVE_API_KEY;
export const PARALLEL_API_KEY =
  process.env.PARALLEL_API_KEY || envConfig.PARALLEL_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = parseInt(
  process.env.IPC_POLL_INTERVAL || envConfig.IPC_POLL_INTERVAL || '1000',
  10,
);
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || envConfig.IDLE_TIMEOUT || '3300000',
  10,
); // 55min default — how long to keep container alive after last result
export const API_TIMEOUT_MS = parseInt(
  process.env.API_TIMEOUT_MS || envConfig.API_TIMEOUT_MS || '1200000',
  10,
);
export const COMPACT_WINDOW = parseInt(
  process.env.COMPACT_WINDOW || envConfig.COMPACT_WINDOW || '160000',
  10,
);
export const MAX_RETRIES = parseInt(
  process.env.MAX_RETRIES || envConfig.MAX_RETRIES || '5',
  10,
);
export const BASE_RETRY_MS = parseInt(
  process.env.BASE_RETRY_MS || envConfig.BASE_RETRY_MS || '5000',
  10,
);
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
