/**
 * Live sanity check: runs real agent turns against Ollama + the running provider
 * on a throwaway SQLite file. Usage: tsx scripts/live-turn.ts "msg1" "msg2" ...
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '@bellhop/shared/clock';
import { createLogger } from '@bellhop/shared/logger';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/open.js';
import { migrateDb } from '../src/db/migrate.js';
import { createProviderClient } from '../src/provider-client/index.js';
import { createAgentModel, runTurn } from '../src/harness/index.js';
import { createMemoryService } from '../src/memory/index.js';

const config = loadConfig();
const logger = createLogger({ name: 'live-turn', level: 'warn' });
const dir = mkdtempSync(join(tmpdir(), 'bellhop-live-'));
const db = openDatabase(join(dir, 'live.db'), { logger });
migrateDb(db, logger);
const memory = createMemoryService({ db, clock: systemClock });
const deps = {
  db,
  clock: systemClock,
  model: createAgentModel(config),
  providerClient: createProviderClient({ baseUrl: config.PROVIDER_URL, timeoutMs: config.PROVIDER_TIMEOUT_MS, logger }),
  logger,
  tracesDir: join(dir, 'traces'),
  limits: {
    modelCalls: config.LIMIT_MODEL_CALLS_PER_TURN,
    toolCalls: config.LIMIT_TOOL_CALLS_PER_TURN,
    wallClockMs: config.LIMIT_TURN_WALL_CLOCK_MS,
    statusChecks: config.LIMIT_STATUS_CHECKS,
    retriesPerTool: config.LIMIT_RETRIES_PER_TOOL,
  },
  memory,
  onEvent: (e: { type: string; summary: string }) => console.log(`   · ${e.type}: ${e.summary}`),
};
for (const text of process.argv.slice(2)) {
  const t0 = Date.now();
  console.log(`\n> USER: ${text}`);
  const r = await runTurn(deps, { userId: 'live-user', text });
  console.log(`< BELLHOP [${r.exit}${r.proposalId ? ' ' + r.proposalId : ''}] (${Date.now() - t0} ms): ${r.reply}`);
}
console.log(`\ntraces: ${join(dir, 'traces')}`);
