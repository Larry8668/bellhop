import type Database from 'better-sqlite3';
import { ConversationSchema, type Conversation } from '../types.js';
import { newId } from '../ids.js';

interface ConversationRow {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
}

function toDomain(row: ConversationRow): Conversation {
  return ConversationSchema.parse(row);
}

export interface ConversationsRepo {
  /** Get-or-create: returns the user's most recently updated conversation, creating one if none exists. */
  ensureConversation(userId: string, now: string): Conversation;
  get(userId: string, id: string): Conversation | undefined;
}

export function createConversationsRepo(db: Database.Database): ConversationsRepo {
  const selectMostRecentStmt = db.prepare(
    'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
  );
  const selectStmt = db.prepare('SELECT * FROM conversations WHERE user_id = ? AND id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );

  return {
    ensureConversation(userId: string, now: string): Conversation {
      const existing = selectMostRecentStmt.get(userId) as ConversationRow | undefined;
      if (existing !== undefined) return toDomain(existing);

      const id = newId('conv');
      insertStmt.run(id, userId, now, now);
      return { id, user_id: userId, created_at: now, updated_at: now };
    },

    get(userId: string, id: string): Conversation | undefined {
      const row = selectStmt.get(userId, id) as ConversationRow | undefined;
      return row === undefined ? undefined : toDomain(row);
    },
  };
}
