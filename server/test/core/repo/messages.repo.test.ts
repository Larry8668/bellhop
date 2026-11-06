import { describe, expect, it } from 'vitest';
import { createConversationsRepo } from '../../../src/core/repo/conversations.repo.js';
import { createMessagesRepo } from '../../../src/core/repo/messages.repo.js';
import { newId } from '../../../src/core/ids.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../helpers.js';
import type { Message } from '../../../src/core/types.js';

function makeMessage(conversationId: string, overrides: Partial<Message> = {}): Message {
  return {
    id: newId('msg'),
    conversation_id: conversationId,
    user_id: TEST_USER,
    role: 'user',
    text: 'hello',
    proposal_id: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('messagesRepo', () => {
  it('append + listRecent round-trips in chronological order', () => {
    const db = createTestDb();
    const conv = createConversationsRepo(db).ensureConversation(TEST_USER, '2026-01-01T00:00:00Z');
    const repo = createMessagesRepo(db);

    const m1 = makeMessage(conv.id, { text: 'first', created_at: '2026-01-01T00:00:00Z' });
    const m2 = makeMessage(conv.id, { role: 'assistant', text: 'second', created_at: '2026-01-01T00:00:01Z' });
    repo.append(m1);
    repo.append(m2);

    expect(repo.listRecent(TEST_USER, 10)).toEqual([m1, m2]);
  });

  it('listRecent respects the limit, keeping the most recent messages', () => {
    const db = createTestDb();
    const conv = createConversationsRepo(db).ensureConversation(TEST_USER, '2026-01-01T00:00:00Z');
    const repo = createMessagesRepo(db);

    for (let i = 0; i < 5; i++) {
      repo.append(makeMessage(conv.id, { text: `msg-${i}`, created_at: `2026-01-01T00:00:0${i}Z` }));
    }

    const recent = repo.listRecent(TEST_USER, 2);
    expect(recent.map((m) => m.text)).toEqual(['msg-3', 'msg-4']);
  });

  it('cross-user listRecent returns empty', () => {
    const db = createTestDb();
    const conv = createConversationsRepo(db).ensureConversation(TEST_USER, '2026-01-01T00:00:00Z');
    createMessagesRepo(db).append(makeMessage(conv.id));

    expect(createMessagesRepo(db).listRecent(OTHER_USER, 10)).toEqual([]);
  });
});
