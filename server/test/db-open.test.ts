import { describe, expect, it } from 'vitest';
import { createLogger } from '@bellhop/shared/logger';
import { openDatabase } from '../src/db/open.js';

describe('openDatabase', () => {
  it('opens an in-memory database with foreign_keys enabled', () => {
    const logger = createLogger({ name: 'test', level: 'silent' });
    const db = openDatabase(':memory:', { logger });

    const row = db.pragma('foreign_keys', { simple: true });
    expect(row).toBe(1);

    db.close();
  });
});
