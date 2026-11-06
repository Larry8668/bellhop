import { afterAll, describe, expect, test } from 'vitest';
import { createLogger } from '@bellhop/shared/logger';
import { createApp } from '../src/app.js';
import { startServer } from '../src/server.js';
import { createTimeoutControl } from '../src/timeouts.js';
import { createTestEngine } from './engine/helpers.js';

describe('provider HTTP shell', () => {
  const logger = createLogger({ name: 'test', level: 'silent' });
  const te = createTestEngine({ seed: 7 });
  const timeouts = createTimeoutControl(20);
  const app = createApp({
    logger,
    clock: te.clock,
    rng: te.rng,
    seed: 7,
    engine: te.engine,
    scenarios: te.scenarios,
    timeouts,
    adminEnabled: true,
  });

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
      pending_scenarios: number;
    };
    expect(body.ok).toBe(true);
    expect(body.now).toBe(te.clock.now().toISOString());
    expect(body.seed).toBe(7);
    expect(body.pending_scenarios).toBe(0);
  });

  test('pending_scenarios reflects queued admin scenarios', async () => {
    te.scenarios.push(['SEARCH_ERROR']);
    try {
      const res = await fetch(`${url}/health`);
      const body = (await res.json()) as { pending_scenarios: number };
      expect(body.pending_scenarios).toBe(1);
    } finally {
      te.scenarios.clear();
    }
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

  test('x-user-id is required on tool routes', async () => {
    const res = await fetch(`${url}/tools/search_providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test('/__admin/state is mounted when admin is enabled', async () => {
    const res = await fetch(`${url}/__admin/state`);
    expect(res.status).toBe(200);
  });
});
