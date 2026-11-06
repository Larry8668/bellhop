import { afterEach, describe, expect, it } from 'vitest';
import { signUpAndSignIn } from '../api/test-helpers.js';
import { setupMcpTest, type McpTestContext } from './setup.js';

let ctx: McpTestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-fetch-test', version: '1.0.0' },
  },
};

describe('MCP route: authentication', () => {
  it('rejects a request with no credentials: HTTP 401', async () => {
    ctx = await setupMcpTest({});

    const res = await fetch(`${ctx.server.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(initializeBody),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('accepts a session cookie: initialize via plain fetch → 200', async () => {
    ctx = await setupMcpTest({});
    const user = await signUpAndSignIn(ctx.apiApp);

    const res = await fetch(`${ctx.server.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: user.cookie,
      },
      body: JSON.stringify(initializeBody),
    });

    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it('rejects a request carrying another principal\'s Mcp-Session-Id, even with otherwise-valid credentials (invariant 2 — a session id is not an identity)', async () => {
    ctx = await setupMcpTest({});
    const userA = await signUpAndSignIn(ctx.apiApp);
    const userB = await signUpAndSignIn(ctx.apiApp);

    const initRes = await fetch(`${ctx.server.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: userA.cookie,
      },
      body: JSON.stringify(initializeBody),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await initRes.body?.cancel();

    const hijackRes = await fetch(`${ctx.server.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: userB.cookie,
        'mcp-session-id': sessionId ?? '',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });

    expect(hijackRes.status).toBe(401);
    const body = (await hijackRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });
});

describe('MCP route: stateless-mode method rules', () => {
  it('GET without an event-stream client → 405', async () => {
    ctx = await setupMcpTest({});
    const user = await signUpAndSignIn(ctx.apiApp);

    const res = await fetch(`${ctx.server.baseUrl}/mcp`, {
      method: 'GET',
      headers: { cookie: user.cookie, accept: 'application/json' },
    });

    expect(res.status).toBe(405);
  });

  it('DELETE → 405 (no session to terminate)', async () => {
    ctx = await setupMcpTest({});
    const user = await signUpAndSignIn(ctx.apiApp);

    const res = await fetch(`${ctx.server.baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { cookie: user.cookie },
    });

    expect(res.status).toBe(405);
  });
});
