import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { parseIncomingRequestId, REQUEST_ID_HEADER } from '@bellhop/shared/contracts';

export type RequestIdEnv = { Variables: { requestId: string } };

export function getRequestId(c: Context): string {
  const id = c.get('requestId');
  if (typeof id === 'string' && id.length > 0) return id;
  throw new Error('requestId middleware must run before getRequestId');
}

export function requestIdMiddleware(): MiddlewareHandler<RequestIdEnv> {
  return async (c, next) => {
    const parsed = parseIncomingRequestId(c.req.header(REQUEST_ID_HEADER));
    const id = parsed ?? randomUUID();
    c.set('requestId', id);
    await next();
    c.header(REQUEST_ID_HEADER, id);
  };
}
