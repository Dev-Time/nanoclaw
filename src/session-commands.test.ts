import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects bare /clear', () => {
    expect(extractSessionCommand('/clear', trigger)).toBe('/clear');
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toBe('/compact');
  });

  it('detects bare /models', () => {
    expect(extractSessionCommand('/models', trigger)).toBe('/models');
  });

  it('detects /models with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /models', trigger)).toBe('/models');
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });

  it('detects /compact with model alias', () => {
    expect(extractSessionCommand('@sonnet /compact', trigger, 'sonnet')).toBe(
      '/compact',
    );
  });

  it('detects /models with model alias', () => {
    expect(extractSessionCommand('@sonnet /models', trigger, 'sonnet')).toBe(
      '/models',
    );
  });

  it('detects /model', () => {
    expect(extractSessionCommand('/model', trigger)).toBe('/model');
  });

  it('detects /model with arguments', () => {
    expect(extractSessionCommand('/model llama3', trigger)).toBe(
      '/model llama3',
    );
  });

  it('detects /model with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /model gemma', trigger)).toBe(
      '/model gemma',
    );
  });

  it('detects /thinking', () => {
    expect(extractSessionCommand('/thinking', trigger)).toBe('/thinking');
  });

  it('detects /thinking with arguments', () => {
    expect(extractSessionCommand('/thinking on', trigger)).toBe('/thinking on');
  });

  it('detects /clear with / trigger', () => {
    const slashTrigger = /^\/\b/i;
    expect(extractSessionCommand('/clear', slashTrigger)).toBe('/clear');
  });

  it('detects /compact with / trigger', () => {
    const slashTrigger = /^\/\b/i;
    expect(extractSessionCommand('/compact', slashTrigger)).toBe('/compact');
  });

  it('detects /model with / trigger', () => {
    const slashTrigger = /^\/\b/i;
    expect(extractSessionCommand('/model llama3', slashTrigger)).toBe(
      '/model llama3',
    );
  });

  it('rejects /compact with extra text', () => {
    expect(
      extractSessionCommand('@gpt4 /compact', trigger, 'sonnet'),
    ).toBeNull();
  });

  it('ignores model alias when no modelKey provided', () => {
    expect(extractSessionCommand('@sonnet /compact', trigger)).toBeNull();
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    getAvailableModelAliases: vi.fn().mockReturnValue(['gemma', 'llama3']),
    chatJid: 'chat@test',
    getChatModel: vi.fn().mockReturnValue(undefined),
    setChatModel: vi.fn(),
    getChatShowThinking: vi.fn().mockReturnValue(false),
    setChatShowThinking: vi.fn(),
    clearSession: vi.fn(),
    ...overrides,
  } as unknown as SessionCommandDeps;
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /models in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/models')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('@gemma'),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('@llama3'),
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('handles authorized /models with no aliases configured', async () => {
    const deps = makeDeps({
      getAvailableModelAliases: vi.fn().mockReturnValue([]),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/models')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'No model aliases configured.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('handles /model to show current model (none set)', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('system default'),
    );
  });

  it('handles /model to show current model (saved)', async () => {
    const deps = makeDeps({ getChatModel: vi.fn().mockReturnValue('gemma') });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('@gemma'),
    );
  });

  it('handles /model default', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model default')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(true);
    expect(deps.setChatModel).toHaveBeenCalledWith('chat@test', null);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('system default'),
    );
  });

  it('handles /model <alias>', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model llama3')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(true);
    expect(deps.setChatModel).toHaveBeenCalledWith('chat@test', 'llama3');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('@llama3'),
    );
  });

  it('handles /model <invalid-alias>', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model unknown')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(true);
    expect(deps.setChatModel).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Unknown model alias'),
    );
  });

  it('handles /thinking to show current status', async () => {
    const deps = makeDeps({
      getChatShowThinking: vi.fn().mockReturnValue(true),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('currently ON'),
    );
  });

  it('handles /thinking on', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking on')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(true);
    expect(deps.setChatShowThinking).toHaveBeenCalledWith('chat@test', true);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('enabled'),
    );
  });

  it('handles /thinking off', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking off')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(true);
    expect(deps.setChatShowThinking).toHaveBeenCalledWith('chat@test', false);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('disabled'),
    );
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('skips pre-command messages before /clear', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('some message', { timestamp: '99' }),
      makeMsg('/clear', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).not.toHaveBeenCalled();
    // Host handles /clear natively, should NOT call runAgent
    expect(deps.clearSession).toHaveBeenCalledTimes(1);
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith('Conversation cleared.');
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });
});
