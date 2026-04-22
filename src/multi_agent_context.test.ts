import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  storeMessage,
  getMessagesSince,
  storeChatMetadata,
} from './db.js';
import { formatMessages } from './router.js';

describe('Multi-agent context sharing', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('allows different agents (aliases) to see each other in context', () => {
    const chatJid = 'group-123';
    const timezone = 'UTC';
    storeChatMetadata(chatJid, new Date().toISOString());

    // 1. Wyatt asks Gemma for F1 explanation
    storeMessage({
      id: 'msg-1',
      chat_jid: chatJid,
      sender: 'wyatt-jid',
      sender_name: 'Wyatt',
      content: '@gemma explain formula 1 racing',
      timestamp: '2024-04-08T10:00:00.000Z',
      is_from_me: false,
    });

    // 2. Gemma responds (stored with alias "gemma" as sender_name)
    storeMessage({
      id: 'bot-msg-1',
      chat_jid: chatJid,
      sender: 'bot',
      sender_name: 'gemma',
      content: 'Formula 1 (F1) is the highest class of international racing...',
      timestamp: '2024-04-08T10:00:05.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    // 3. Wyatt asks Andy what he thinks
    storeMessage({
      id: 'msg-2',
      chat_jid: chatJid,
      sender: 'wyatt-jid',
      sender_name: 'Wyatt',
      content: 'Andy, what do you think of that description?',
      timestamp: '2024-04-08T10:00:10.000Z',
      is_from_me: false,
    });

    // 4. Andy (the default agent) fetches context
    // In NanoClaw, default assistantName is "Andy"
    const assistantName = 'Andy';
    const messages = getMessagesSince(
      chatJid,
      '1970-01-01T00:00:00.000Z',
    );

    // VERIFY: Gemma's message is included in the DB results
    const gemmaMsg = messages.find((m) => m.sender_name === 'gemma');
    expect(gemmaMsg).toBeDefined();
    expect(gemmaMsg?.content).toContain('Formula 1 (F1)');

    // 5. Format messages for Andy
    const formatted = formatMessages(messages, timezone);

    // VERIFY: Gemma's message is in the XML formatted context
    expect(formatted).toContain('sender="gemma"');
    expect(formatted).toContain('Formula 1 (F1)');

    // VERIFY: Wyatt's messages are also there
    expect(formatted).toContain('sender="Wyatt"');
    expect(formatted).toContain('Andy, what do you think');
  });
});
