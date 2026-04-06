import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config before importing model-router so ASSISTANT_NAME is controlled
vi.mock('./config.js', () => ({ ASSISTANT_NAME: 'Andy' }));

// Mock logger to silence output during tests
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Mock fs before importing model-router so the mock is in place at module load
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const mockReadFileSync = vi.fn(() => '');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: mockReadFileSync,
    },
    readFileSync: mockReadFileSync,
  };
});

import fs from 'fs';

import {
  getAvailableModelAliases,
  loadModelConfigs,
  resetModelConfigCache,
  resolveModelAlias,
} from './model-router.js';

const mockReadFile = vi.mocked(fs.readFileSync);

const VALID_YAML = `
models:
  - alias: llama3
    base_url: http://host.docker.internal:11434/v1
    model: llama3:8b
  - alias: auto
    base_url: https://openrouter.ai/api/v1
    model: openrouter/auto
  - alias: gemma
    base_url: http://host.docker.internal:11434/v1
    model: gemma4:26b
`;

afterEach(() => {
  resetModelConfigCache();
  vi.clearAllMocks();
});

describe('loadModelConfigs', () => {
  it('parses a valid models.yaml and returns configs', () => {
    mockReadFile.mockReturnValueOnce(VALID_YAML as never);
    const configs = loadModelConfigs();
    expect(configs).toHaveLength(3);
    expect(configs[0]).toEqual({
      alias: 'llama3',
      baseUrl: 'http://host.docker.internal:11434/v1',
      model: 'llama3:8b',
    });
  });

  it('supports model names with slashes (openrouter/auto)', () => {
    mockReadFile.mockReturnValueOnce(VALID_YAML as never);
    const configs = loadModelConfigs();
    const auto = configs.find((c) => c.alias === 'auto');
    expect(auto?.model).toBe('openrouter/auto');
  });

  it('supports model names with colons (gemma4:26b)', () => {
    mockReadFile.mockReturnValueOnce(VALID_YAML as never);
    const configs = loadModelConfigs();
    const gemma = configs.find((c) => c.alias === 'gemma');
    expect(gemma?.model).toBe('gemma4:26b');
  });

  it('returns empty array when models.yaml does not exist', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFile.mockImplementationOnce(() => {
      throw err;
    });
    expect(loadModelConfigs()).toEqual([]);
  });

  it('returns empty array on malformed YAML', () => {
    mockReadFile.mockReturnValueOnce('models: {invalid: [yaml' as never);
    expect(loadModelConfigs()).toEqual([]);
  });

  it('returns empty array when models key is missing', () => {
    mockReadFile.mockReturnValueOnce('something_else: []' as never);
    expect(loadModelConfigs()).toEqual([]);
  });

  it('returns empty array when models is empty list', () => {
    mockReadFile.mockReturnValueOnce('models: []' as never);
    expect(loadModelConfigs()).toEqual([]);
  });

  it('skips entries missing alias', () => {
    const yaml = `
models:
  - base_url: http://localhost/v1
    model: llama3
  - alias: valid
    base_url: http://localhost/v1
    model: llama3
`;
    mockReadFile.mockReturnValueOnce(yaml as never);
    const configs = loadModelConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].alias).toBe('valid');
  });

  it('caches after first load (does not re-read file)', () => {
    mockReadFile.mockReturnValueOnce(VALID_YAML as never);
    loadModelConfigs();
    loadModelConfigs();
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });
});

describe('resolveModelAlias', () => {
  beforeEach(() => {
    mockReadFile.mockReturnValue(VALID_YAML as never);
  });

  it('returns config and stripped prompt for a known alias', () => {
    const result = resolveModelAlias('@llama3 hello world');
    expect(result).not.toBeNull();
    expect(result).not.toBe('unknown-alias');
    const r = result as { config: { alias: string }; strippedPrompt: string };
    expect(r.config.alias).toBe('llama3');
    expect(r.strippedPrompt).toBe('hello world');
  });

  it('is case-insensitive for the alias', () => {
    const result = resolveModelAlias('@Llama3 test');
    expect(result).not.toBeNull();
    expect(result).not.toBe('unknown-alias');
  });

  it('strips the alias prefix leaving only the message', () => {
    const result = resolveModelAlias('@auto what is 2+2?');
    expect(result).not.toBe('unknown-alias');
    expect(result).not.toBeNull();
    const r = result as { strippedPrompt: string };
    expect(r.strippedPrompt).toBe('what is 2+2?');
  });

  it('returns null for messages not starting with @', () => {
    expect(resolveModelAlias('hello world')).toBeNull();
    expect(resolveModelAlias('what is @llama3')).toBeNull();
  });

  it('returns null when the alias matches the group trigger', () => {
    expect(resolveModelAlias('@Andy hello', '@Andy')).toBeNull();
  });

  it('returns null when the alias matches ASSISTANT_NAME (Andy)', () => {
    // ASSISTANT_NAME is mocked as 'Andy'
    expect(resolveModelAlias('@andy hello')).toBeNull();
  });

  it('returns unknown-alias for unrecognized @word', () => {
    expect(resolveModelAlias('@unknownmodel hello')).toBe('unknown-alias');
  });

  it('returns null for @word that matches a custom group trigger', () => {
    expect(resolveModelAlias('@bot hello', '@bot')).toBeNull();
  });

  it('handles alias-only message (no trailing text)', () => {
    const result = resolveModelAlias('@llama3');
    expect(result).not.toBeNull();
    expect(result).not.toBe('unknown-alias');
    const r = result as { strippedPrompt: string };
    expect(r.strippedPrompt).toBe('');
  });
});

describe('getAvailableModelAliases', () => {
  it('returns the list of alias names', () => {
    mockReadFile.mockReturnValueOnce(VALID_YAML as never);
    const aliases = getAvailableModelAliases();
    expect(aliases).toContain('llama3');
    expect(aliases).toContain('auto');
    expect(aliases).toContain('gemma');
  });

  it('returns empty array when no models configured', () => {
    mockReadFile.mockReturnValueOnce('models: []' as never);
    expect(getAvailableModelAliases()).toEqual([]);
  });
});
