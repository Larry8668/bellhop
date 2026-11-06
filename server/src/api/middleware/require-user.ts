import type { MiddlewareHandler } from 'hono';
import type { Auth } from '../../auth/auth.js';
import type { Principal } from '../../auth/principal.js';
import { resolvePrincipal } from '../../auth/principal.js';

export interface AppVariables {
  principal: Principal;
}

/**
 * Resolves the principal (session or API key) and rejects with 401 if
 * neither is present. Downstream handlers read `c.get('principal')` for
 * `user_id` — never the body or query (coding-standards.mdc invariant 2).
 */
export function requireUser(auth: Auth): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const principal = await resolvePrincipal(auth, c.req.raw.headers);
    if (!principal) {
      return c.json({ error: { code: 'unauthorized', message: 'authentication required' } }, 401);
    }
    c.set('principal', principal);
    await next();
  };
}
