import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';

import { ASSISTANT_NAME } from './config.js';
import { logger } from './logger.js';

export interface ModelConfig {
  alias: string;
  baseUrl: string;
  model: string;
}

// Loaded once at startup, then cached for the process lifetime.
let cachedConfigs: ModelConfig[] | null = null;

export function loadModelConfigs(): ModelConfig[] {
  if (cachedConfigs !== null) return cachedConfigs;

  const filePath = path.join(process.cwd(), 'models.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cachedConfigs = [];
      return cachedConfigs;
    }
    logger.warn({ err }, 'Failed to read models.yaml — model aliases disabled');
    cachedConfigs = [];
    return cachedConfigs;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    logger.warn({ err }, 'Failed to parse models.yaml — model aliases disabled');
    cachedConfigs = [];
    return cachedConfigs;
  }

  if (!parsed || typeof parsed !== 'object' || !('models' in parsed)) {
    logger.warn('models.yaml missing top-level "models" key — model aliases disabled');
    cachedConfigs = [];
    return cachedConfigs;
  }

  const rawModels = (parsed as { models: unknown }).models;
  if (!Array.isArray(rawModels)) {
    if (rawModels !== null && rawModels !== undefined) {
      logger.warn('models.yaml "models" must be a list — model aliases disabled');
    }
    cachedConfigs = [];
    return cachedConfigs;
  }

  const configs: ModelConfig[] = [];
  for (const entry of rawModels) {
    if (!entry || typeof entry !== 'object') {
      logger.warn({ entry }, 'Skipping invalid model entry (not an object)');
      continue;
    }
    const { alias, base_url, model } = entry as Record<string, unknown>;
    if (typeof alias !== 'string' || !alias.trim()) {
      logger.warn({ entry }, 'Skipping model entry — missing or empty "alias"');
      continue;
    }
    if (typeof base_url !== 'string' || !base_url.trim()) {
      logger.warn({ entry }, 'Skipping model entry — missing or empty "base_url"');
      continue;
    }
    if (typeof model !== 'string' || !model.trim()) {
      logger.warn({ entry }, 'Skipping model entry — missing or empty "model"');
      continue;
    }
    configs.push({ alias: alias.trim(), baseUrl: base_url.trim(), model: model.trim() });
  }

  logger.info({ count: configs.length }, 'Model aliases loaded');
  cachedConfigs = configs;
  return cachedConfigs;
}

/**
 * Check if a message starts with a known model alias (@alias ...).
 *
 * Returns:
 *   null           — no alias pattern detected (message doesn't start with @word)
 *   'unknown-alias'— starts with @word but it's not a known alias or group trigger
 *   { config, strippedPrompt } — known alias found; strippedPrompt has the @alias removed
 *
 * groupTrigger is excluded from alias matching (e.g. "@Andy" stays a trigger, not an alias).
 */
export function resolveModelAlias(
  content: string,
  groupTrigger?: string,
): { config: ModelConfig; strippedPrompt: string } | 'unknown-alias' | null {
  const trimmed = content.trim();
  const match = /^@([\w][\w-]*)\b/i.exec(trimmed);
  if (!match) return null;

  const candidate = match[1].toLowerCase();

  // Exclude the group trigger and the assistant name from alias matching
  const triggerWord = groupTrigger?.replace(/^@/, '').toLowerCase();
  const assistantWord = ASSISTANT_NAME.toLowerCase();
  if (candidate === triggerWord || candidate === assistantWord) return null;

  const configs = loadModelConfigs();
  const found = configs.find((c) => c.alias.toLowerCase() === candidate);
  if (!found) return 'unknown-alias';

  const strippedPrompt = trimmed.slice(match[0].length).trim();
  return { config: found, strippedPrompt };
}

export function getAvailableModelAliases(): string[] {
  return loadModelConfigs().map((c) => c.alias);
}

/** Reset the cache — used in tests. */
export function resetModelConfigCache(): void {
  cachedConfigs = null;
}
