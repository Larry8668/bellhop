import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createLogger } from '@bellhop/shared/logger';
import { startServer } from '../src/server.js';

describe('startServer', () => {
  it('binds an ephemeral port and serves the app until closed', async () => {
    const app = new Hono();
    app.get('/api/health', (c) => c.json({ ok: true }));
    const logger = createLogger({ name: 'test', level: 'silent' });

    const { port, url, close } = await startServer({ app, port: 0, logger });

    expect(port).toBeGreaterThan(0);
    expect(url).toBe(`http://127.0.0.1:${port}`);

    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    await close();
  });
});
