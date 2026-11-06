/**
 * Demo memories and a prior conversation for the seeded account (plan §11).
 * Service ids are the provider's (`plumber`, `electrician`, `ac_servicing`);
 * areas match `provider/src/db/seed.ts`. Irrelevant facts carry a `topic:`
 * tag so selection does not treat them as untagged general prefs.
 * Fixed ids and timestamps make a second run a no-op.
 */
import type { Service } from '@bellhop/shared/contracts';
import type { Logger } from '@bellhop/shared/logger';
import type Database from 'better-sqlite3';
import { createMessagesRepo } from '../src/core/repo/messages.repo.js';
import type { Message, MessageRole } from '../src/core/types.js';
import { createMemoryRepo, type StoredMemory } from '../src/memory/repo.js';
import type { FactKind, FactStatus } from '../src/memory/types.js';

const CONV_ID = 'conv_demo';
const BASE_MS = Date.UTC(2026, 0, 10, 8, 0, 0);
const SERVICES: readonly Service[] = ['plumber', 'electrician', 'ac_servicing'];
const AREAS = ['indiranagar', 'koramangala', 'whitefield'] as const;
const EXTRA_FACTS = 42;

interface SeedFact {
  id: string;
  key: string;
  value: string;
  kind: FactKind;
  status: FactStatus;
  tags: string[];
}

export interface DemoHistoryCounts {
  memories: number;
  messages: number;
}

const CORE_FACTS: readonly SeedFact[] = [
  {
    id: 'mem_demo_preferred_time',
    key: 'preferred_time',
    value: 'not before 10:00',
    kind: 'explicit',
    status: 'active',
    tags: ['general'],
  },
  {
    id: 'mem_demo_language',
    key: 'preferred_language',
    value: 'English',
    kind: 'explicit',
    status: 'active',
    tags: [],
  },
  {
    id: 'mem_demo_home_area',
    key: 'home_area',
    value: 'Indiranagar',
    kind: 'explicit',
    status: 'active',
    tags: ['area:indiranagar'],
  },
  {
    id: 'mem_demo_plumber_budget',
    key: 'plumber_budget',
    value: '1200 INR',
    kind: 'explicit',
    status: 'active',
    tags: ['service:plumber', 'area:indiranagar'],
  },
  {
    id: 'mem_demo_plumber_access',
    key: 'plumber_access',
    value: 'call before arriving',
    kind: 'explicit',
    status: 'active',
    tags: ['service:plumber'],
  },
  {
    id: 'mem_demo_electrician_last',
    key: 'electrician_last',
    value: 'Metro Electricals',
    kind: 'explicit',
    status: 'active',
    tags: ['service:electrician', 'area:indiranagar'],
  },
  {
    id: 'mem_demo_electrician_hours',
    key: 'electrician_hours',
    value: 'not before 10:00',
    kind: 'explicit',
    status: 'active',
    tags: ['service:electrician'],
  },
  {
    id: 'mem_demo_ac',
    key: 'ac_preference',
    value: 'service the split AC before summer',
    kind: 'explicit',
    status: 'active',
    tags: ['service:ac_servicing', 'area:indiranagar'],
  },
  {
    id: 'mem_demo_cuisine',
    key: 'favorite_cuisine',
    value: 'South Indian',
    kind: 'explicit',
    status: 'active',
    tags: ['topic:food'],
  },
  {
    id: 'mem_demo_color',
    key: 'favorite_color',
    value: 'indigo',
    kind: 'inferred',
    status: 'unconfirmed',
    tags: ['topic:personal'],
  },
  {
    id: 'mem_demo_old_address',
    key: 'old_address',
    value: 'Koramangala flat',
    kind: 'explicit',
    status: 'forgotten',
    tags: ['area:koramangala'],
  },
  {
    id: 'mem_demo_old_plumber',
    key: 'old_plumber',
    value: 'Ravi Kumar Plumbing',
    kind: 'explicit',
    status: 'forgotten',
    tags: ['service:plumber', 'area:indiranagar'],
  },
];

/** Twenty turns: forty messages of prior plumber / electrician / AC chat. */
const TURNS: ReadonlyArray<readonly [string, string]> = [
  ['I need a plumber in Indiranagar tomorrow.', 'I can look for plumbers in Indiranagar. Any time or budget constraints?'],
  ['Not before 10, and keep it around 1200.', 'I will only propose slots after 10 within that budget.'],
  ['They should be licensed and bring parts.', 'Noted. I will prefer licensed plumbers who bring parts.'],
  ['Same area as home, Indiranagar, not Koramangala.', 'Searching Indiranagar only.'],
  ['What did you find?', 'Three licensed plumbers have morning slots after 10. I can propose one when you pick.'],
  ['The one we used last time was fine.', 'I will treat that as a preference for the previous plumber and still show alternatives.'],
  ['Go ahead and hold the morning slot.', 'A hold is ready. Please confirm on the card before I book anything.'],
  ['Confirming the plumber visit.', 'Booked. You will get a reminder the day before.'],
  ['Next, an electrician for the same flat.', 'Electrician in Indiranagar. Same "not before 10" rule?'],
  ['Yes, and use Metro Electricals if they are free.', 'I will look at Metro Electricals first, then other electricians in Indiranagar.'],
  ['They came last month for the kitchen lights.', 'I have that as the last electrician. I will not book without a new confirmation.'],
  ['Budget can go to 1600 for electrical.', 'Electrical budget noted at 1600. I will not exceed it in a proposal.'],
  ['Also the AC needs a service before summer.', 'AC servicing in Indiranagar. Any brand or access notes?'],
  ['Split AC, and call before arriving.', 'Noted for AC servicing. I will ask them to call first.'],
  ['Do not use the Koramangala contacts anymore.', 'Those stay out of Indiranagar searches.'],
  ['My favorite cuisine is South Indian, but that is unrelated.', 'I will keep that off the booking context. It is not a service preference.'],
  ['Remind me what you know about plumbers.', 'Licensed, brings parts, Indiranagar, not before 10, budget about 1200.'],
  ['Change the plumber budget to 1500.', 'Updated. Future plumber proposals will use 1500.'],
  ['Thanks. That is all for today.', 'All set. Nothing else will be booked unless you confirm a card.'],
  ['One more thing: mornings only, please.', 'Morning slots only, still not before 10. I will remember that for next time.'],
];

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`seed index ${index} is out of range`);
  return item;
}

function stamp(index: number): string {
  return new Date(BASE_MS + index * 60_000).toISOString();
}

function extraFacts(): SeedFact[] {
  const facts: SeedFact[] = [];
  for (let i = 0; i < EXTRA_FACTS; i++) {
    const service = at(SERVICES, i % SERVICES.length);
    const area = at(AREAS, i % AREAS.length);
    const irrelevant = i % 4 === 0;
    const kind: FactKind = i % 3 === 0 ? 'inferred' : 'explicit';
    let status: FactStatus = 'active';
    if (i % 11 === 0) status = 'forgotten';
    else if (kind === 'inferred' && i % 2 === 0) status = 'unconfirmed';
    facts.push({
      id: `mem_demo_x_${String(i).padStart(3, '0')}`,
      key: irrelevant ? `misc_pref_${i}` : `${service}_note_${i}`,
      value: irrelevant ? `unrelated personal detail ${i}` : `${service} note ${i} for ${area}`,
      kind,
      status,
      tags: irrelevant ? ['topic:personal'] : [`service:${service}`, `area:${area}`],
    });
  }
  return facts;
}

function memoryRows(userId: string): StoredMemory[] {
  return [...CORE_FACTS, ...extraFacts()].map((fact, index) => {
    const atTime = stamp(index);
    return {
      id: fact.id,
      userId,
      key: fact.key,
      value: fact.value,
      kind: fact.kind,
      status: fact.status,
      tags: fact.tags,
      createdAt: atTime,
      updatedAt: atTime,
    };
  });
}

function countRows(db: Database.Database, table: 'memories' | 'messages', userId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number };
  return row.n;
}

function existingIds(db: Database.Database, table: 'memories' | 'messages', userId: string): Set<string> {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE user_id = ?`).all(userId) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function seedMemories(db: Database.Database, userId: string): number {
  const repo = createMemoryRepo(db);
  const rows = memoryRows(userId);
  const write = db.transaction(() => {
    const have = existingIds(db, 'memories', userId);
    for (const row of rows) {
      if (have.has(row.id)) continue;
      repo.insert(row);
    }
  });
  write();
  return countRows(db, 'memories', userId);
}

function seedConversation(db: Database.Database, userId: string): number {
  const messages = createMessagesRepo(db);
  const start = stamp(0);
  const end = stamp(TURNS.length * 2 - 1);
  const write = db.transaction(() => {
    const exists = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(CONV_ID, userId);
    if (exists === undefined) {
      db.prepare(
        'INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run(CONV_ID, userId, start, end);
    }
    const have = existingIds(db, 'messages', userId);
    let inserted = 0;
    let index = 0;
    for (const turn of TURNS) {
      inserted += appendMessage(messages, have, userId, index, 'user', turn[0]);
      index += 1;
      inserted += appendMessage(messages, have, userId, index, 'assistant', turn[1]);
      index += 1;
    }
    if (inserted > 0) {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?').run(end, CONV_ID, userId);
    }
  });
  write();
  return countRows(db, 'messages', userId);
}

function appendMessage(
  messages: ReturnType<typeof createMessagesRepo>,
  have: Set<string>,
  userId: string,
  index: number,
  role: MessageRole,
  text: string,
): number {
  const id = `msg_demo_${String(index).padStart(2, '0')}`;
  if (have.has(id)) return 0;
  const message: Message = {
    id,
    conversation_id: CONV_ID,
    user_id: userId,
    role,
    text,
    proposal_id: null,
    created_at: stamp(index),
  };
  messages.append(message);
  have.add(id);
  return 1;
}

export function seedDemoHistory(db: Database.Database, userId: string, logger: Logger): DemoHistoryCounts {
  const memories = seedMemories(db, userId);
  const messages = seedConversation(db, userId);
  logger.info({ userId, memories, messages }, 'demo history ready');
  return { memories, messages };
}
