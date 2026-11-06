import type { Auth } from './auth.js';

export interface Principal {
  userId: string;
  via: 'session' | 'api_key';
  email?: string;
}

/**
 * Resolves the calling user from the request itself — never from a body or
 * query param (coding-standards.mdc invariant 2). Order: session cookie,
 * then API key (`Authorization: Bearer <key>` or `x-api-key`).
 */
export async function resolvePrincipal(auth: Auth, headers: Headers): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers });
  if (session) {
    return { userId: session.user.id, via: 'session', email: session.user.email };
  }

  const key = extractApiKey(headers);
  if (!key) return null;

  const result = await auth.api.verifyApiKey({ body: { key } });
  if (!result.valid || !result.key) return null;

  return { userId: result.key.referenceId, via: 'api_key' };
}

function extractApiKey(headers: Headers): string | null {
  const authorization = headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim();
  }
  return headers.get('x-api-key');
}
