import { afterAll, describe, expect, test } from 'vitest';
import { createLogger } from '@bellhop/shared/logger';
import { createFakeClock } from '@bellhop/shared/clock';
import { createSeededRng } from '@bellhop/shared/rng';
import { createApp } from '../src/app.js';
import { startServer } from '../src/server.js';

describe('provider HTTP shell', () => {
  const clock = createFakeClock(1_700_000_000_000);
  const rng = createSeededRng(7);
  const logger = createLogger({ name: 'test', level: 'silent' });
  const app = createApp({ logger, clock, rng, seed: 7 });

  const serverPromise = startServer({ app, port: 0, logger });

  let url = '';

  afterAll(async () => {
    const { close } = await serverPromise;
    await close();
  });

  test('GET /health', async () => {
    const { url: base } = await serverPromise;
    url = base;

    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      now: string;
      seed: number;
    };
    expect(body.ok).toBe(true);
    expect(body.now).toBe(clock.now().toISOString());
    expect(body.seed).toBe(7);
  });

  test('unknown route returns 404', async () => {
    if (!url) {
      const { url: base } = await serverPromise;
      url = base;
    }

    const res = await fetch(`${url}/no-such-route`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error).toEqual({
      code: 'not_found',
      message: 'no such route',
    });
  });
});
