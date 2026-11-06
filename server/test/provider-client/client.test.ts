import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  REQUEST_ID_HEADER,
  USER_ID_HEADER,
  type SearchProvidersInput,
  type SearchProvidersOutput,
} from '@bellhop/shared/contracts';
import { createLogger } from '@bellhop/shared/logger';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '../../src/config.js';
import {
  createProviderAdminClient,
  createProviderClient,
  ProviderError,
} from '../../src/provider-client/index.js';

function isTcpAddress(addr: string | AddressInfo | null): addr is AddressInfo {
  return (
    typeof addr === 'object' &&
    addr !== null &&
    'port' in addr &&
    typeof addr.port === 'number'
  );
}

async function startStub(app: Hono): Promise<{ baseUrl: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    let server: ReturnType<typeof serve>;
    try {
      server = serve(
        {
          fetch: app.fetch.bind(app),
          port: 0,
        },
        () => {
          const addr = server.address();
          if (!isTcpAddress(addr)) {
            reject(new Error('server address is not TCP'));
            return;
          }
          resolve({
            baseUrl: `http://127.0.0.1:${addr.port}`,
            close() {
              return new Promise((closeResolve, closeReject) => {
                server.close((err) => {
                  if (err) closeReject(err);
                  else closeResolve();
                });
              });
            },
          });
        },
      );
    } catch (err) {
      reject(err);
      return;
    }
    server.on('error', reject);
  });
}

describe('provider-client', () => {
  const logger = createLogger({ name: 'test', level: 'silent' });

  describe('createProviderClient', () => {
    it('search_providers 200: parses output and forwards header + JSON body', async () => {
      const app = new Hono();
      let seenHeader: string | undefined;
      let seenRequestId: string | undefined;
      let seenBody: unknown;

      app.post('/tools/search_providers', async (c) => {
        seenHeader = c.req.header(USER_ID_HEADER);
        seenRequestId = c.req.header(REQUEST_ID_HEADER);
        seenBody = await c.req.json();
        return c.json({
          providers: [
            {
              id: 'p1',
              name: 'Test Plumber',
              service: 'plumber',
              area: 'Indiranagar',
              price: 500,
              currency: 'INR',
              rating: 4.5,
              slots: [
                {
                  start: '2026-11-10T10:00:00.000Z',
                  end: '2026-11-10T11:00:00.000Z',
                },
              ],
              attributes: [],
            },
          ],
        } satisfies SearchProvidersOutput);
      });

      const { baseUrl, close } = await startStub(app);
      try {
        const client = createProviderClient({
          baseUrl,
          timeoutMs: 5000,
          logger,
        });
        const input: SearchProvidersInput = {
          service: 'plumber',
          area: 'Indiranagar',
          date_range: {
            from: '2026-11-09T00:00:00.000Z',
            to: '2026-11-11T00:00:00.000Z',
          },
        };
        const out = await client.search_providers('user-1', input, {
          requestId: 'corr-1',
        });

        expect(seenHeader).toBe('user-1');
        expect(seenRequestId).toBe('corr-1');
        expect(seenBody).toEqual(input);
        expect(out.providers).toHaveLength(1);
        expect(out.providers[0]?.id).toBe('p1');
      } finally {
        await close();
      }
    });

    it('book 409 slot_taken: ProviderError with tool, code, status', async () => {
      const app = new Hono();
      app.post('/tools/book', (c) =>
        c.json({ error: { code: 'slot_taken', message: 'x' } }, 409),
      );
      const { baseUrl, close } = await startStub(app);
      try {
        const client = createProviderClient({ baseUrl, timeoutMs: 5000, logger });
        await expect(
          client.book('u', { hold_id: 'h1', idempotency_key: 'k1' }),
        ).rejects.toMatchObject({
          name: 'ProviderError',
          tool: 'book',
          code: 'slot_taken',
          status: 409,
          message: 'x',
        });
      } finally {
        await close();
      }
    });

    it('reschedule 409 slot_conflict preserves details.alternatives', async () => {
      const app = new Hono();
      app.post('/tools/reschedule', (c) =>
        c.json(
          {
            error: {
              code: 'slot_conflict',
              message: 'm',
              details: {
                alternatives: [{ start: '2026-11-10T12:00:00.000Z', end: '2026-11-10T13:00:00.000Z' }],
              },
            },
          },
          409,
        ),
      );
      const { baseUrl, close } = await startStub(app);
      try {
        const client = createProviderClient({ baseUrl, timeoutMs: 5000, logger });
        try {
          await client.reschedule('u', {
            booking_id: 'b1',
            idempotency_key: 'k',
            slot: { start: '2026-11-10T10:00:00.000Z', end: '2026-11-10T11:00:00.000Z' },
          });
          expect.fail('expected throw');
        } catch (e) {
          expect(ProviderError.isProviderError(e, 'slot_conflict')).toBe(true);
          if (ProviderError.isProviderError(e)) {
            expect(e.details).toEqual({
              alternatives: [{ start: '2026-11-10T12:00:00.000Z', end: '2026-11-10T13:00:00.000Z' }],
            });
          }
        }
      } finally {
        await close();
      }
    });

    it('timeout: stub delays, client short timeout → code timeout, timedOut true', async () => {
      const app = new Hono();
      app.post('/tools/get_provider', async (c) => {
        await new Promise((r) => setTimeout(r, 300));
        return c.json({
          provider: {
            id: 'p1',
            name: 'x',
            service: 'plumber',
            area: 'a',
            price: 1,
            currency: 'INR',
            rating: 3,
            slots: [],
            attributes: [],
            description: 'd',
            years_active: 1,
            reviews: [],
          },
        });
      });
      const { baseUrl, close } = await startStub(app);
      try {
        const client = createProviderClient({ baseUrl, timeoutMs: 50, logger });
        await expect(client.get_provider('u', { provider_id: 'p1' })).rejects.toMatchObject({
          code: 'timeout',
          timedOut: true,
          tool: 'get_provider',
        });
      } finally {
        await close();
      }
    });

    it('200 with invalid shape → internal with issues in details', async () => {
      const app = new Hono();
      app.post('/tools/search_providers', () => {
        return Response.json({ providers: 'not-an-array' }, { status: 200 });
      });
      const { baseUrl, close } = await startStub(app);
      try {
        const client = createProviderClient({ baseUrl, timeoutMs: 5000, logger });
        try {
          await client.search_providers('u', {
            service: 'plumber',
            area: 'a',
            date_range: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' },
          });
          expect.fail('expected throw');
        } catch (e) {
          expect(ProviderError.isProviderError(e, 'internal')).toBe(true);
          if (ProviderError.isProviderError(e)) {
            expect(e.message).toBe('invalid provider response');
            expect(Array.isArray(e.details)).toBe(true);
          }
        }
      } finally {
        await close();
      }
    });

    it('bad input: bad_request and stub receives no request', async () => {
      const app = new Hono();
      let hit = false;
      app.post('/tools/search_providers', async () => {
        hit = true;
        return new Response(null, { status: 500 });
      });
      const { baseUrl, close } = await startStub(app);
      try {
        const client = createProviderClient({ baseUrl, timeoutMs: 5000, logger });
        await expect(
          client.search_providers('u', {
            service: 'plumber',
            area: '',
            date_range: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' },
          } as SearchProvidersInput),
        ).rejects.toMatchObject({ code: 'bad_request', tool: 'search_providers' });
        expect(hit).toBe(false);
      } finally {
        await close();
      }
    });

    it('empty userId: unauthorized, no request', async () => {
      const app = new Hono();
      let hit = false;
      app.post('/tools/list_bookings', async () => {
        hit = true;
        return new Response(null, { status: 500 });
      });
      const { baseUrl, close } = await startStub(app);
      try {
        const client = createProviderClient({ baseUrl, timeoutMs: 5000, logger });
        await expect(client.list_bookings('', { user_id: 'x' })).rejects.toMatchObject({
          code: 'unauthorized',
          tool: 'list_bookings',
        });
        expect(hit).toBe(false);
      } finally {
        await close();
      }
    });

    it('closed port → transient', async () => {
      const client = createProviderClient({
        baseUrl: 'http://127.0.0.1:1',
        timeoutMs: 2000,
        logger,
      });
      await expect(
        client.get_provider('u', { provider_id: 'p1' }),
      ).rejects.toMatchObject({ code: 'transient', tool: 'get_provider' });
    });
  });

  describe('createProviderAdminClient', () => {
    it('state() parses AdminStateResponse', async () => {
      const minimal = {
        now: '2026-11-06T12:00:00.000Z',
        seed: 42,
        pending_scenarios: [],
        timeout_delay_ms: 0,
        holds: [],
        bookings: [],
        idempotency: [],
      };
      const app = new Hono();
      app.get('/__admin/state', (c) => c.json(minimal));
      const { baseUrl, close } = await startStub(app);
      try {
        const admin = createProviderAdminClient({ baseUrl });
        const state = await admin.state();
        expect(state).toEqual(minimal);
      } finally {
        await close();
      }
    });
  });

  describe('loadConfig', () => {
    it('default PROVIDER_TIMEOUT_MS is 5000', () => {
      expect(loadConfig({}).PROVIDER_TIMEOUT_MS).toBe(5000);
    });
  });
});
