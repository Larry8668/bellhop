import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Logger } from '@bellhop/shared/logger';
import type { Hono } from 'hono';

function isTcpAddress(
  addr: string | AddressInfo | null,
): addr is AddressInfo {
  return (
    typeof addr === 'object' &&
    addr !== null &&
    'port' in addr &&
    typeof addr.port === 'number'
  );
}

export async function startServer(opts: {
  app: Pick<Hono, 'fetch'>;
  port: number;
  logger: Logger;
}): Promise<{ port: number; url: string; close(): Promise<void> }> {
  const { app, port, logger: _logger } = opts;
  void _logger;

  return new Promise((resolve, reject) => {
    let server: ReturnType<typeof serve>;

    try {
      server = serve(
        {
          fetch: app.fetch.bind(app),
          port,
        },
        () => {
          const addr = server.address();
          if (!isTcpAddress(addr)) {
            reject(new Error('server address is not TCP'));
            return;
          }

          const boundPort = addr.port;
          const url = `http://127.0.0.1:${boundPort}`;

          resolve({
            port: boundPort,
            url,
            close(): Promise<void> {
              return new Promise((closeResolve, closeReject) => {
                server.close((err) => {
                  if (err) {
                    closeReject(err);
                  } else {
                    closeResolve();
                  }
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
