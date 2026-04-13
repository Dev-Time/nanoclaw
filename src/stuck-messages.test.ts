import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _setRegisteredGroups, processGroupMessages } from './index.js';
import * as db from './db.js';
import * as sessionCommands from './session-commands.js';
import { makeSlotKey } from './slot-key.js';

import * as router from './router.js';

// Mock dependencies
vi.mock('./db.js');
vi.mock('./session-commands.js');
vi.mock('./router.js');
vi.mock('./config.js', async () => {
  const actual = (await vi.importActual('./config.js')) as any;
  return {
    ...actual,
    ASSISTANT_NAME: 'Andy',
    MAX_MESSAGES_PER_PROMPT: 200,
    getTriggerPattern: vi.fn().mockReturnValue(/^@Andy\b/i),
  };
});

describe('processGroupMessages loop and routing', () => {
  const chatJid = 'group@test';
  const trigger = /^@Andy\b/i;

  beforeEach(() => {
    vi.clearAllMocks();
    _setRegisteredGroups({
      [chatJid]: {
        name: 'Test Group',
        folder: 'test',
        trigger: '@Andy',
        isMain: true,
      },
    });
    vi.mocked(router.findChannel).mockReturnValue({
      name: 'test-channel',
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendMessage: vi.fn(),
      setTyping: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('processes multiple session commands followed by a regular message', async () => {
    const msgs = [
      { id: '1', chat_jid: chatJid, content: '/model gemma', timestamp: '100', is_from_me: false },
      { id: '2', chat_jid: chatJid, content: '/model llama3', timestamp: '101', is_from_me: false },
      { id: '3', chat_jid: chatJid, content: 'Hello', timestamp: '102', is_from_me: false },
    ];

    let cursor = '0';
    vi.mocked(db.getMessagesSince).mockImplementation((jid, ts) => {
      return msgs.filter(m => m.timestamp > ts);
    });
    vi.mocked(db.getChatModel).mockReturnValue(undefined);

    // Mock handleSessionCommand to simulate processing one command at a time
    vi.mocked(sessionCommands.handleSessionCommand).mockImplementation(async (opts) => {
      const firstMsg = opts.missedMessages[0];
      if (firstMsg.content.startsWith('/model ')) {
        const alias = firstMsg.content.split(' ')[1];
        vi.mocked(db.getChatModel).mockReturnValue(alias);
        opts.deps.advanceCursor(firstMsg.timestamp);
        cursor = firstMsg.timestamp;
        return { handled: true, success: true };
      }
      return { handled: false };
    });

    // Run for default slot
    const result = await processGroupMessages(chatJid);

    // Should have processed first command and then returned true because model changed
    expect(result).toBe(true);
    expect(sessionCommands.handleSessionCommand).toHaveBeenCalledTimes(1);
    expect(db.getChatModel).toHaveBeenCalled();
    // Default model changed to gemma, should have re-enqueued
    expect(db.getMessagesSince).toHaveBeenCalledWith(chatJid, expect.any(String), 'Andy', 200);
  });
});
