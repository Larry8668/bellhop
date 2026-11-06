import { describe, expect, it } from 'vitest';
import { createConversationsRepo } from '../../../src/core/repo/conversations.repo.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../helpers.js';

describe('conversationsRepo', () => {
  it('ensureConversation creates one when none exists', () => {
    const repo = createConversationsRepo(createTestDb());
    const conv = repo.ensureConversation(TEST_USER, '2026-01-01T00:00:00Z');

    expect(conv.user_id).toBe(TEST_USER);
    expect(repo.get(TEST_USER, conv.id)).toEqual(conv);
  });

  it('ensureConversation is idempotent: a second call returns the same (most recent) conversation', () => {
    const repo = createConversationsRepo(createTestDb());
    const first = repo.ensureConversation(TEST_USER, '2026-01-01T00:00:00Z');
    const second = repo.ensureConversation(TEST_USER, '2026-01-01T00:05:00Z');

    expect(second.id).toBe(first.id);
  });

  it('cross-user get returns undefined', () => {
    const repo = createConversationsRepo(createTestDb());
    const conv = repo.ensureConversation(TEST_USER, '2026-01-01T00:00:00Z');

    expect(repo.get(OTHER_USER, conv.id)).toBeUndefined();
  });
});
