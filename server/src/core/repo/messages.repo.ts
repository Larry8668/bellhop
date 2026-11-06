import type Database from 'better-sqlite3';
import { MessageSchema, type Message } from '../types.js';

interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  role: Message['role'];
  text: string;
  proposal_id: string | null;
  created_at: string;
}

function toDomain(row: MessageRow): Message {
  return MessageSchema.parse(row);
}

export interface MessagesRepo {
  /** Caller supplies a fully-formed `Message` (id from `newId('msg')`) — same convention as `proposalsRepo.insert`. */
  append(message: Message): void;
  /** Most recent `limit` messages for the user, in chronological order. */
  listRecent(userId: string, limit: number): Message[];
  /** Every message for the user, oldest first. `rowid` breaks ties on `created_at`. */
  listAll(userId: string): Message[];
}

export function createMessagesRepo(db: Database.Database): MessagesRepo {
  const insertStmt = db.prepare(`
    INSERT INTO messages (id, conversation_id, user_id, role, text, proposal_id, created_at)
    VALUES (@id, @conversation_id, @user_id, @role, @text, @proposal_id, @created_at)
  `);
  const listRecentStmt = db.prepare(
    'SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
  );
  const listAllStmt = db.prepare(
    'SELECT * FROM messages WHERE user_id = ? ORDER BY created_at ASC, rowid ASC',
  );

  return {
    append(message: Message): void {
      insertStmt.run({
        id: message.id,
        conversation_id: message.conversation_id,
        user_id: message.user_id,
        role: message.role,
        text: message.text,
        proposal_id: message.proposal_id,
        created_at: message.created_at,
      });
    },

    listRecent(userId: string, limit: number): Message[] {
      const rows = listRecentStmt.all(userId, limit) as MessageRow[];
      return rows.map(toDomain).reverse();
    },

    listAll(userId: string): Message[] {
      const rows = listAllStmt.all(userId) as MessageRow[];
      return rows.map(toDomain);
    },
  };
}
