import { betterAuth } from 'better-auth';
import type { Auth as BetterAuth } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import type Database from 'better-sqlite3';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';

export interface CreateAuthDeps {
  db: Database.Database;
  secret: string;
  baseUrl: string;
  logger: Logger;
  /** Origins Better Auth accepts for CORS/CSRF checks. Defaults to the web dev origin. */
  trustedOrigins?: string[];
}

type AuthLogLevel = 'debug' | 'info' | 'warn' | 'error';

// Written out explicitly (not `ReturnType<typeof buildOptions>`) so every
// field keeps the exact type we wrote in source. An inferred version of this
// type hits TS4058 ("cannot be named") on `database`: better-sqlite3's own
// `.d.ts` reaches its `Database` type through an internal namespace that
// isn't part of its public export surface, so the compiler can't synthesize
// a printable reference to it once this is embedded in the exported
// `createAuth` return type — only an explicit annotation, echoed verbatim,
// survives declaration emit.
interface AuthOptions {
  database: Database.Database;
  secret: string;
  baseURL: string;
  basePath: string;
  trustedOrigins: string[];
  emailAndPassword: { enabled: boolean };
  plugins: [ReturnType<typeof apiKey>];
  advanced: {
    useSecureCookies: boolean;
    defaultCookieAttributes: { sameSite: 'lax'; secure: boolean };
  };
  logger: {
    disabled: boolean;
    log: (level: AuthLogLevel, message: string, ...args: unknown[]) => void;
  };
}

/**
 * Factored out so `scripts/gen-auth-migration.ts` can build the exact same
 * options against a throwaway db to regenerate `db/migrations/0001_auth.sql`,
 * and so the schema-drift guard test can rebuild them for `getMigrations`.
 */
export function buildOptions({ db, secret, baseUrl, logger, trustedOrigins }: CreateAuthDeps): AuthOptions {
  const authLog = childLogger(logger, 'better-auth');

  return {
    database: db,
    secret,
    baseURL: baseUrl,
    basePath: '/api/auth',
    trustedOrigins: trustedOrigins ?? ['http://localhost:5173'],
    emailAndPassword: {
      enabled: true,
    },
    plugins: [apiKey()],
    // Dev-mode same-site cookies: UI (5173) and server are different ports
    // but the same "site" (http://localhost), so `lax` + non-secure works
    // without HTTPS. Set explicitly rather than relying on the library
    // default so this stays correct if that default ever changes.
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: false,
      },
    },
    logger: {
      disabled: false,
      log(level, message, ...args) {
        authLog[level]({ args }, message);
      },
    },
  };
}

/**
 * Builds the Better Auth instance (plan §14/§15): email+password for the UI,
 * the API Key plugin for MCP/CLI clients. `db` is a live better-sqlite3
 * connection — Better Auth's kysely adapter detects it (has `aggregate`,
 * no `createSession`) and wraps it with a SqliteDialect directly, no ORM
 * layer needed.
 */
export function createAuth(deps: CreateAuthDeps): BetterAuth<AuthOptions> {
  return betterAuth(buildOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;
