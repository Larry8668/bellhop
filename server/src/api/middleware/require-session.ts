import type { MiddlewareHandler } from 'hono';
import type { Auth } from '../../auth/auth.js';
import { resolvePrincipal } from '../../auth/principal.js';
import type { AppVariables } from './require-user.js';

/**
 * Like `requireUser`, but additionally rejects an API-key principal. An MCP
 * client config holds the API key, and the coding agent driving the model
 * can read that config and shell out to curl — so routes that create an
 * approval (and therefore a booking/cancel/reschedule) must only ever be
 * reachable by a human in the web UI or through MCP elicitation, never by a
 * bearer token the model itself could use (coding-standards.mdc invariant 1).
 */
export function requireSession(auth: Auth): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const principal = await resolvePrincipal(auth, c.req.raw.headers);
    if (!principal) {
      return c.json({ error: { code: 'unauthorized', message: 'authentication required' } }, 401);
    }
    if (principal.via !== 'session') {
      return c.json(
        { error: { code: 'session_required', message: 'approvals require a signed-in browser session' } },
        403,
      );
    }
    c.set('principal', principal);
    await next();
  };
}
