/**
 * Seeds extra demo personas for the demo video: `fresh@`, `returning@` and
 * `mover@bellhop.local` (password `demo-pass-123`). The two with a booking get
 * a real confirmed booking made through the core engine against the running
 * provider (search, propose, approve, execute). Idempotent: existing users are
 * kept, memories use fixed ids, and a user with any booking is not re-booked.
 *
 * Env: DB_PATH (./data/bellhop.db), PROVIDER_URL (http://localhost:4010),
 * BETTER_AUTH_SECRET (insecure dev default with a warning, as in seed-demo).
 */
import type Database from 'better-sqlite3';
import { systemClock } from '@bellhop/shared/clock';
import type { Service } from '@bellhop/shared/contracts';
import { createLogger } from '@bellhop/shared/logger';
import { openSqlite } from '@bellhop/shared/sqlite';
import { createAuth } from '../src/auth/auth.js';
import { createCoreEngine } from '../src/core/engine.js';
import { migrateDb } from '../src/db/migrate.js';
import { createMemoryRepo } from '../src/memory/repo.js';
import type { FactKind, FactStatus } from '../src/memory/types.js';
import { createProviderAdminClient } from '../src/provider-client/admin.js';
import { createProviderClient } from '../src/provider-client/client.js';
import { createTraceWriter } from '../src/trace/writer.js';

const PASSWORD = 'demo-pass-123';
const INSECURE_DEFAULT_SECRET = 'dev-secret-change-me';
/** Providers whose reviews carry prompt-injection text; kept free for the injection demo. */
const INJECTION_PROVIDERS = new Set(['prv_34', 'prv_35', 'prv_73']);

interface FactSpec {
  key: string;
  value: string;
  kind: FactKind;
  status: FactStatus;
  tags: string[];
}
interface BookingSpec {
  service: Service;
  area: string;
}
interface Persona {
  email: string;
  name: string;
  slug: string;
  booking?: BookingSpec;
  /** Facts that need the booked provider id. */
  facts: (providerId: string | undefined) => FactSpec[];
}

const PERSONAS: Persona[] = [
  { email: 'fresh@bellhop.local', name: 'Fresh User', slug: 'fresh', facts: () => [] },
  {
    email: 'returning@bellhop.local',
    name: 'Returning User',
    slug: 'returning',
    booking: { service: 'electrician', area: 'Koramangala' },
    facts: (providerId) => [
      { key: 'area', value: 'Koramangala', kind: 'explicit', status: 'active', tags: ['area:Koramangala'] },
      { key: 'not_before', value: '10:00', kind: 'explicit', status: 'active', tags: ['general'] },
      ...(providerId === undefined
        ? []
        : [
            {
              key: 'preferred_electrician',
              value: providerId,
              kind: 'explicit' as const,
              status: 'active' as const,
              tags: ['service:electrician'],
            },
          ]),
      { key: 'prefers_weekends', value: 'yes', kind: 'inferred', status: 'unconfirmed', tags: ['general'] },
      { key: 'old_phone_note', value: 'call the old landline', kind: 'explicit', status: 'forgotten', tags: ['general'] },
    ],
  },
  {
    email: 'mover@bellhop.local',
    name: 'Mover User',
    slug: 'mover',
    booking: { service: 'ac_servicing', area: 'Whitefield' },
    facts: () => [
      { key: 'area', value: 'Whitefield', kind: 'explicit', status: 'active', tags: ['area:Whitefield'] },
    ],
  },
];

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? './data/bellhop.db';
  const providerUrl = process.env.PROVIDER_URL ?? 'http://localhost:4010';
  let secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    console.warn(`BETTER_AUTH_SECRET is not set; using insecure default "${INSECURE_DEFAULT_SECRET}" (dev only)`);
    secret = INSECURE_DEFAULT_SECRET;
  }

  const logger = createLogger({ name: 'seed-demo-users', level: 'warn' });
  const db = openSqlite(dbPath, { logger });
  const auth = createAuth({ db, secret, baseUrl: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000', logger });
  migrateDb(db, logger);
  const context = await auth.$context;
  const providerClient = createProviderClient({ baseUrl: providerUrl, timeoutMs: 5000, logger });
  const admin = createProviderAdminClient({ baseUrl: providerUrl });
  const tracesDir = process.env.TRACES_DIR ?? './data/traces';

  const rows: string[][] = [];
  for (const p of PERSONAS) {
    const existing = await context.internalAdapter.findUserByEmail(p.email);
    let userId: string;
    if (existing) {
      userId = existing.user.id;
    } else {
      userId = (await auth.api.signUpEmail({ body: { email: p.email, password: PASSWORD, name: p.name } })).user.id;
    }

    const engine = createCoreEngine({
      db,
      clock: systemClock,
      providerClient,
      trace: createTraceWriter({ dir: tracesDir, runId: `seed_demo_users_${p.slug}_${Date.now()}`, clock: systemClock }),
      logger,
      limits: { statusChecks: 3, retriesPerTool: 2 },
    });

    let providerId: string | undefined;
    const existingBookings = engine.bookings.list(userId);
    if (existingBookings.length > 0) {
      providerId = existingBookings[0]!.provider_id;
    } else if (p.booking) {
      providerId = await createBooking(p.booking, userId, engine, providerClient, admin);
    }

    insertFacts(db, userId, p, p.facts(providerId));
    const bookings = engine.bookings.list(userId);
    const mem = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(userId) as { n: number }).n;
    rows.push([p.email, String(bookings.filter((b) => b.status === 'confirmed').length), String(mem)]);
  }
  db.close();

  console.log('\nemail\t\t\t\tconfirmed bookings\tmemories');
  for (const r of rows) console.log(`${r[0]!.padEnd(28)}\t${r[1]}\t\t\t${r[2]}`);
}

type Engine = ReturnType<typeof createCoreEngine>;

async function createBooking(
  spec: BookingSpec,
  userId: string,
  engine: Engine,
  client: ReturnType<typeof createProviderClient>,
  admin: ReturnType<typeof createProviderAdminClient>,
): Promise<string> {
  const from = systemClock.now().toISOString();
  const to = new Date(systemClock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { providers } = await client.search_providers(userId, {
    service: spec.service,
    area: spec.area,
    date_range: { from, to },
  });
  const provider = providers.find((x) => !INJECTION_PROVIDERS.has(x.id) && x.slots.length > 0);
  if (!provider) throw new Error(`no suitable ${spec.service} provider in ${spec.area}`);
  await admin.scenario({ outcomes: ['BOOK_SUCCESS'] });
  const proposed = await engine.proposals.proposeBooking(userId, { provider_id: provider.id, slot: provider.slots[0]! });
  if (!proposed.ok) throw new Error(`proposeBooking failed: ${proposed.code} ${proposed.message}`);
  const approved = engine.approvals.approve(userId, {
    proposal_id: proposed.proposal.id,
    hash: proposed.proposal.hash,
    source: 'button',
  });
  if (!approved.ok) throw new Error(`approve failed: ${approved.reason}`);
  const outcome = await engine.executor.execute(userId, approved.approval.id);
  if (outcome.kind !== 'booked') throw new Error(`execute did not book: ${outcome.kind}`);
  return provider.id;
}

function insertFacts(db: Database.Database, userId: string, p: Persona, facts: FactSpec[]): void {
  const repo = createMemoryRepo(db);
  const now = systemClock.now().toISOString();
  for (const f of facts) {
    const id = `mem_${p.slug}_${f.key}`;
    if (repo.getById(userId, id)) continue;
    repo.insert({ id, userId, ...f, createdAt: now, updatedAt: now });
  }
}

main().catch((err) => {
  console.error('seed-demo-users failed:', err);
  process.exitCode = 1;
});
