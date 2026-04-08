import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  storeMessage,
  getMessagesSince,
  getNewMessages,
  storeChatMetadata,
} from './db.js';

describe('Bot message storage and retrieval', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores and retrieves a bot message', () => {
    const chatJid = 'test-chat';
    // Create the chat first to satisfy foreign key constraint
    storeChatMetadata(chatJid, new Date().toISOString());

    const msg = {
      id: 'bot-123',
      chat_jid: chatJid,
      sender: 'bot',
      sender_name: 'Andy',
      content: 'Hello world',
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    };

    storeMessage(msg);

    // Check with getMessagesSince
    const messages = getMessagesSince(
      chatJid,
      '1970-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('bot-123');
    expect(messages[0].is_bot_message).toBe(1); // SQLite returns 1 for true

    // Check with getNewMessages
    const { messages: newMsgs } = getNewMessages(
      [chatJid],
      '1970-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(newMsgs).toHaveLength(1);
    expect(newMsgs[0].id).toBe('bot-123');
    expect(newMsgs[0].is_bot_message).toBe(1);
  });

  it('stores and retrieves a large bot message', () => {
    const chatJid = 'large-chat';
    storeChatMetadata(chatJid, new Date().toISOString());

    const largeContent = 'A'.repeat(100000); // 100KB
    const msg = {
      id: 'bot-large',
      chat_jid: chatJid,
      sender: 'bot',
      sender_name: 'Andy',
      content: largeContent,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    };

    storeMessage(msg);

    const messages = getMessagesSince(
      chatJid,
      '1970-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(largeContent);
  });
});
