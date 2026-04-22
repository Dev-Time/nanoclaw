import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  getMessagesSince,
  storeMessage,
  storeChatMetadata,
} from './db.js';

describe('Reproduction: Bot messages from others are filtered out', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('includes messages starting with ASSISTANT_NAME', () => {
    const chatJid = 'group@g.us';
    storeChatMetadata(chatJid, '2024-01-01T00:00:00.000Z');

    // Message from another agent/bot that starts with the assistant name
    storeMessage({
      id: 'msg-1',
      chat_jid: chatJid,
      sender: 'other-bot@s.whatsapp.net',
      sender_name: 'OtherBot',
      content: 'Andy: Hello from another bot',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
    });

    const messages = getMessagesSince(
      chatJid,
      '2024-01-01T00:00:00.000Z',
    );

    // CURRENT BEHAVIOR: Now should have 1 message
    expect(messages).toHaveLength(1);
  });

  it('includes messages marked with is_bot_message=1', () => {
    const chatJid = 'group@g.us';
    storeChatMetadata(chatJid, '2024-01-01T00:00:00.000Z');

    // Message explicitly marked as bot message
    storeMessage({
      id: 'msg-2',
      chat_jid: chatJid,
      sender: 'other-bot@s.whatsapp.net',
      sender_name: 'OtherBot',
      content: 'I am a bot too',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
      is_bot_message: true,
    });

    const messages = getMessagesSince(
      chatJid,
      '2024-01-01T00:00:00.000Z',
    );

    // CURRENT BEHAVIOR: Returns the message (expected for context/history)
    expect(messages).toHaveLength(1);
  });
});
