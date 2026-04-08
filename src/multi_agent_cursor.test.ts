import { describe, it, expect, beforeEach, vi } from 'vitest';
import { 
  _initTestDatabase, 
  storeMessage, 
  storeChatMetadata,
  getMessagesSince
} from './db.js';

describe('Multi-agent cursor isolation', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('allows independent cursors for different agents', () => {
    const chatJid = 'group-123';
    storeChatMetadata(chatJid, '2024-04-08T10:00:00.000Z');

    // 1. User asks question
    storeMessage({
      id: 'msg-1',
      chat_jid: chatJid,
      sender: 'user',
      sender_name: 'User',
      content: 'Hi Andy and @gemma',
      timestamp: '2024-04-08T10:00:01.000Z',
      is_from_me: false,
    });

    // Assume lastAgentTimestamp is maintained outside the DB for now.
    // Default agent (Andy) cursor starts at 0.
    const andyCursor = '1970-01-01T00:00:00.000Z';
    const gemmaCursor = '1970-01-01T00:00:00.000Z';

    // Both see the user message
    const andyMessages = getMessagesSince(chatJid, andyCursor, 'Andy');
    const gemmaMessages = getMessagesSince(chatJid, gemmaCursor, 'Andy');

    expect(andyMessages).toHaveLength(1);
    expect(gemmaMessages).toHaveLength(1);
    expect(andyMessages[0].content).toBe('Hi Andy and @gemma');
    expect(gemmaMessages[0].content).toBe('Hi Andy and @gemma');

    // 2. Andy runs and responds
    const andyResponseTs = '2024-04-08T10:00:05.000Z';
    storeMessage({
      id: 'bot-andy-1',
      chat_jid: chatJid,
      sender: 'bot',
      sender_name: 'Andy',
      content: 'Hello! I am Andy.',
      timestamp: andyResponseTs,
      is_from_me: true,
      is_bot_message: true,
    });

    // Andy advances his cursor to his own response timestamp
    const nextAndyCursor = andyResponseTs;

    // 3. Gemma runs. If Gemma had used Andy's cursor (the old behavior), she would miss context!
    // But with independent cursors, she still uses gemmaCursor.
    const gemmaContext = getMessagesSince(chatJid, gemmaCursor, 'Andy');
    
    // Gemma should see both the user message and Andy's response!
    expect(gemmaContext).toHaveLength(2);
    expect(gemmaContext[0].content).toBe('Hi Andy and @gemma');
    expect(gemmaContext[1].content).toBe('Hello! I am Andy.');
  });
});
