import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, type ElicitRequestFormParams, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';

export interface RunningServer {
  baseUrl: string;
  close(): Promise<void>;
}

function isTcpAddress(addr: AddressInfo | string | null): addr is AddressInfo {
  return typeof addr === 'object' && addr !== null && 'port' in addr && typeof addr.port === 'number';
}

/**
 * Starts a Hono app on an ephemeral port. MCP tests need a real HTTP server
 * (not `app.request(...)`) because the SDK's `StreamableHTTPClientTransport`
 * and a session-cookie `fetch` both need an actual URL to connect to.
 */
export async function startServer(app: Hono): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    let server: ReturnType<typeof serve>;
    try {
      server = serve({ fetch: app.fetch.bind(app), port: 0 }, () => {
        const addr = server.address();
        if (!isTcpAddress(addr)) {
          reject(new Error('server address is not TCP'));
          return;
        }
        resolve({
          baseUrl: `http://127.0.0.1:${addr.port}`,
          close() {
            // The MCP client keeps an idle SSE connection open for
            // server-initiated notifications; plain `server.close()` waits
            // forever for it. Force every socket closed first (Node 18.2+).
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

export type ElicitationHandler = (
  params: ElicitRequestFormParams,
) => ElicitResult | Promise<ElicitResult>;

/**
 * Connects an MCP SDK `Client` to `${baseUrl}/mcp` over Streamable HTTP,
 * authenticated with whatever `headers` carry (API key or cookie).
 * `client.connect` performs the `initialize` handshake.
 *
 * Pass `elicitation` to declare the `elicitation` client capability and
 * answer `elicitation/create` requests the way the propose/approval tests
 * need (plan §7 — MCP elicitation is the only non-UI approval path).
 * Omitting it connects a client with no elicitation support, exercising
 * the web-fallback path.
 */
export async function connectMcpClient(
  baseUrl: string,
  headers: Record<string, string>,
  opts: { elicitation?: ElicitationHandler } = {},
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client(
    { name: 'bellhop-test-client', version: '1.0.0' },
    { capabilities: opts.elicitation ? { elicitation: {} } : {} },
  );
  if (opts.elicitation) {
    const handler = opts.elicitation;
    client.setRequestHandler(ElicitRequestSchema, async (request) => handler(request.params as ElicitRequestFormParams));
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return { client, transport };
}
