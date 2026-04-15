import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { readEnvFile } from './env.js';

vi.mock('fs');
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('readEnvFile', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('parses basic key-value pairs', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('KEY1=VALUE1\nKEY2=VALUE2');
    const result = readEnvFile(['KEY1', 'KEY2']);
    expect(result).toEqual({ KEY1: 'VALUE1', KEY2: 'VALUE2' });
  });

  it('filters only requested keys', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('KEY1=VALUE1\nKEY2=VALUE2');
    const result = readEnvFile(['KEY1']);
    expect(result).toEqual({ KEY1: 'VALUE1' });
    expect(result).not.toHaveProperty('KEY2');
  });

  it('handles comments and empty lines', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('# comment\n\nKEY1=VALUE1\n  # indented comment');
    const result = readEnvFile(['KEY1']);
    expect(result).toEqual({ KEY1: 'VALUE1' });
  });

  it('trims whitespace from keys and values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('  KEY1  =  VALUE1  ');
    const result = readEnvFile(['KEY1']);
    expect(result).toEqual({ KEY1: 'VALUE1' });
  });

  it('handles double quoted values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('KEY1="VALUE1"');
    const result = readEnvFile(['KEY1']);
    expect(result).toEqual({ KEY1: 'VALUE1' });
  });

  it('handles single quoted values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue("KEY1='VALUE1'");
    const result = readEnvFile(['KEY1']);
    expect(result).toEqual({ KEY1: 'VALUE1' });
  });

  it('returns empty object when .env file is missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('File not found');
    });
    const result = readEnvFile(['KEY1']);
    expect(result).toEqual({});
  });

  it('skips lines without =', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('KEY1VALUE1');
    const result = readEnvFile(['KEY1']);
    expect(result).toEqual({});
  });

  it('handles multiple = in a single line', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('KEY1=VAL1=VAL2');
    const result = readEnvFile(['KEY1']);
    expect(result).toEqual({ KEY1: 'VAL1=VAL2' });
  });

  it('skips empty values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('KEY1=');
    const result = readEnvFile(['KEY1']);
    expect(result).toEqual({});
  });
});
