import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  REQUEST_ID_HEADER,
  TOOL_CONTRACTS,
  USER_ID_HEADER,
  type ToolName,
} from '@bellhop/shared/contracts';

export type StubProviderRoute = (body: unknown, userId: string) => { status: number; body: unknown };

export interface StubProviderCall {
  tool: ToolName;
  userId: string;
  requestId: string | undefined;
  body: unknown;
}

export interface StubProvider {
  url: string;
  calls: StubProviderCall[];
  close(): Promise<void>;
}

function isTcpAddress(addr: AddressInfo | string | null): addr is AddressInfo {
  return typeof addr === 'object' && addr !== null && 'port' in addr && typeof addr.port === 'number';
}

/**
 * Minimal stand-in for the real provider service (plan §4). Mounts one POST
 * route per `ToolName` present in `routes`, on an ephemeral port, and
 * records every call it receives — tool name, the `x-user-id` header it saw,
 * and the parsed body — so tests can assert on `user_id` forwarding
 * (coding-standards.mdc invariant 2) without a real provider process.
 *
 * `createProviderClient` is the real client under test; this only replaces
 * the HTTP server it talks to.
 */
export async function startStubProvider(
  routes: Partial<Record<ToolName, StubProviderRoute>>,
): Promise<StubProvider> {
  const app = new Hono();
  const calls: StubProviderCall[] = [];

  for (const [name, handler] of Object.entries(routes) as Array<[ToolName, StubProviderRoute]>) {
    const { path } = TOOL_CONTRACTS[name];
    app.post(path, async (c) => {
      const userId = c.req.header(USER_ID_HEADER) ?? '';
      const requestId = c.req.header(REQUEST_ID_HEADER);
      const body: unknown = await c.req.json().catch(() => null);
      calls.push({ tool: name, userId, requestId, body });
      const { status, body: responseBody } = handler(body, userId);
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
  }

  return new Promise((resolve, reject) => {
    let server: ReturnType<typeof serve>;
    try {
      server = serve({ fetch: app.fetch.bind(app), port: 0 }, () => {
        const addr = server.address();
        if (!isTcpAddress(addr)) {
          reject(new Error('stub provider address is not TCP'));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          calls,
          close() {
            // `fetch`'s keep-alive connection pool can leave a socket open
            // after the last request; force it closed so `server.close()`'s
            // callback actually fires instead of waiting for it to idle out.
            // `serve()` always returns a plain `http.Server` here (no http2
            // option passed); `ServerType` just unions in the http2 variant.
            (server as Server).closeAllConnections();
            return new Promise((closeResolve, closeReject) => {
              server.close((err) => (err ? closeReject(err) : closeResolve()));
            });
          },
        });
      });
    } catch (err) {
      reject(err as Error);
      return;
    }
    server.on('error', reject);
  });
}
