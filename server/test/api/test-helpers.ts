import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LanguageModel } from 'ai';
import { systemClock } from '@bellhop/shared/clock';
import { createLogger } from '@bellhop/shared/logger';
import type { Logger } from '@bellhop/shared/logger';
import Database from 'better-sqlite3';
import { createUserQueue } from '../../src/core/queue/user-queue.js';
import { openDatabase } from '../../src/db/open.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { migrateDb } from '../../src/db/migrate.js';
import { createApiApp } from '../../src/api/app.js';
import type { ProviderAdmin } from '../../src/api/chat.js';
import { createEventBus, type EventBus } from '../../src/events/bus.js';
import { scriptedModel, textStep } from '../../src/harness/scripted-model.js';
import type { ProviderClient } from '../../src/provider-client/client.js';
import type { HarnessMemory, Proactive, RunTurn, TurnLimits } from '../../src/wiring/deps.js';

export const WEB_ORIGIN = 'http://localhost:5173';

/** A `list_bookings`-only stub; routes that don't touch bookings never call it. */
const noopProviderClient: Partial<ProviderClient> = {
  list_bookings: () => Promise.resolve({ bookings: [] }),
};

export interface TestAuthSetup {
  auth: Auth;
  db: Database.Database;
  logger: Logger;
}

/** In-memory Better Auth instance with tables migrated, ready for a test. */
export async function setupTestAuth(): Promise<TestAuthSetup> {
  const logger = createLogger({ name: 'test', level: 'silent' });
  const db = openDatabase(':memory:', { logger });
  const auth = createAuth({ db, secret: 'test-secret-do-not-use-in-production', baseUrl: 'http://localhost:3000', logger });
  migrateDb(db, logger);
  return { auth, db, logger };
}

export interface TestAppSetup extends TestAuthSetup {
  app: ReturnType<typeof createApiApp>;
}

/** In-memory app + auth pair, ready to receive `app.request(...)` calls. */
const TEST_LIMITS = { statusChecks: 3, retriesPerTool: 2 } as const;

const DEFAULT_TURN_LIMITS: TurnLimits = {
  modelCalls: 8,
  toolCalls: 15,
  wallClockMs: 60_000,
  statusChecks: 3,
  retriesPerTool: 2,
};

/** Memory that stores nothing. Chat and MCP tests replace methods when they need facts. */
export function emptyMemory(): HarnessMemory {
  return {
    selectForContext: () => [],
    remember: () => { throw new Error('unused'); },
    forget: () => false,
    getProfile: () => [],
    logContext: () => {},
  };
}

export interface ApiWiring {
  model: LanguageModel;
  memory: HarnessMemory;
  bus: EventBus;
  turnLimits: TurnLimits;
  runTurn: RunTurn;
  proactive: Proactive;
  devRoutes: boolean;
  providerAdmin: ProviderAdmin;
}

/** Defaults so existing API/MCP suites can construct `createApiApp` without a live harness. */
export function apiWiring(overrides: Partial<ApiWiring> = {}): ApiWiring {
  return {
    model: scriptedModel([textStep('ok')]),
    memory: emptyMemory(),
    bus: createEventBus(),
    turnLimits: DEFAULT_TURN_LIMITS,
    runTurn: () => Promise.reject(new Error('not wired')),
    proactive: {
      tick: () => Promise.resolve(),
      start: () => () => {},
    },
    devRoutes: true,
    providerAdmin: {
      cancelBooking: () => Promise.resolve(),
    },
    ...overrides,
  };
}

export async function setupTestApp(deps: { providerClient?: Partial<ProviderClient> } = {}): Promise<TestAppSetup> {
  const setup = await setupTestAuth();
  const tracesDir = mkdtempSync(path.join(tmpdir(), 'bellhop-api-test-'));
  const queue = createUserQueue({ logger: setup.logger });
  const app = createApiApp({
    auth: setup.auth,
    logger: setup.logger,
    providerClient: (deps.providerClient ?? noopProviderClient) as ProviderClient,
    webOrigin: WEB_ORIGIN,
    db: setup.db,
    clock: systemClock,
    limits: TEST_LIMITS,
    tracesDir,
    queue,
    ...apiWiring(),
  });
  return { ...setup, app };
}

export interface SignedUpUser {
  email: string;
  password: string;
  name: string;
  cookie: string;
}

/**
 * Signs up and signs in a fresh user through the real HTTP routes, returning
 * the `Cookie` header value to authenticate subsequent requests with.
 */
export async function signUpAndSignIn(
  app: ReturnType<typeof createApiApp>,
  overrides: Partial<{ email: string; password: string; name: string }> = {},
): Promise<SignedUpUser> {
  const email = overrides.email ?? `user-${crypto.randomUUID()}@example.com`;
  const password = overrides.password ?? 'correct-horse-battery-staple';
  const name = overrides.name ?? 'Test User';

  const signUpRes = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (signUpRes.status !== 200) {
    throw new Error(`sign-up failed: ${signUpRes.status} ${await signUpRes.text()}`);
  }

  const signInRes = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (signInRes.status !== 200) {
    throw new Error(`sign-in failed: ${signInRes.status} ${await signInRes.text()}`);
  }

  const setCookies = signInRes.headers.getSetCookie();
  const sessionCookie = setCookies[0];
  if (!sessionCookie) {
    throw new Error('sign-in did not return a set-cookie header');
  }
  // `set-cookie` carries attributes (Path, HttpOnly, ...); only the
  // `name=value` pair belongs in a `Cookie` request header.
  const cookie = sessionCookie.split(';')[0] ?? '';

  return { email, password, name, cookie };
}

/** Signs up a fresh user and mints an API key for it, for tests that exercise the API-key auth path. */
export async function createApiKeyUser(
  app: ReturnType<typeof createApiApp>,
): Promise<{ user: SignedUpUser; apiKey: string }> {
  const user = await signUpAndSignIn(app);
  const createRes = await app.request('/api/keys', {
    method: 'POST',
    headers: { cookie: user.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test key' }),
  });
  if (createRes.status !== 201) {
    throw new Error(`api key creation failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { key } = (await createRes.json()) as { key: string };
  return { user, apiKey: key };
}
