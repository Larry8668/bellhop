import { describe, expect, it } from 'vitest';
import { seedDemo } from '../../scripts/seed-demo.js';
import { setupTestAuth } from '../api/test-helpers.js';

describe('seedDemo history', () => {
  it('seeds 50+ mixed memories and 40 messages, and a second run does not add rows', async () => {
    const setup = await setupTestAuth();
    const first = await seedDemo(setup.auth, setup.logger, setup.db);

    const counts = (): { memories: number; messages: number } => {
      const memories = setup.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      const messages = setup.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
      return { memories: memories.n, messages: messages.n };
    };
    const before = counts();
    expect(before.memories).toBeGreaterThanOrEqual(50);
    expect(before.messages).toBe(40);
    expect(first).toContain(`memories=${before.memories}`);
    expect(first).toContain('messages=40');

    const mix = setup.db
      .prepare('SELECT kind, status, COUNT(*) AS n FROM memories GROUP BY kind, status')
      .all() as Array<{ kind: string; status: string; n: number }>;
    expect(mix.some((row) => row.kind === 'explicit' && row.n > 0)).toBe(true);
    expect(mix.some((row) => row.kind === 'inferred' && row.n > 0)).toBe(true);
    expect(mix.some((row) => row.status === 'active' && row.n > 0)).toBe(true);
    expect(mix.some((row) => row.status === 'unconfirmed' && row.n > 0)).toBe(true);
    expect(mix.some((row) => row.status === 'forgotten' && row.n > 0)).toBe(true);

    const cuisine = setup.db.prepare("SELECT value, tags_json FROM memories WHERE key = 'favorite_cuisine'").get() as {
      value: string;
      tags_json: string;
    };
    expect(cuisine.value).toBe('South Indian');
    expect(cuisine.tags_json).toContain('topic:food');

    const tagged = setup.db
      .prepare("SELECT tags_json FROM memories WHERE tags_json LIKE '%service:ac_servicing%' AND tags_json LIKE '%area:indiranagar%'")
      .all() as Array<{ tags_json: string }>;
    expect(tagged.length).toBeGreaterThan(0);
    const services = ['service:plumber', 'service:electrician', 'service:ac_servicing'] as const;
    for (const service of services) {
      const found = setup.db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE tags_json LIKE ?')
        .get(`%${service}%`) as { n: number };
      expect(found.n).toBeGreaterThan(0);
    }

    const mention = setup.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%Indiranagar%'")
      .get() as { n: number };
    expect(mention.n).toBeGreaterThan(0);

    const second = await seedDemo(setup.auth, setup.logger, setup.db);
    expect(counts()).toEqual(before);
    expect(second).toContain('already exists');
    setup.db.close();
  });
});
