import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSummary, Slot } from '@bellhop/shared/contracts';
import { runTurn, type TurnLimits } from '../../src/harness/agent.js';
import { scriptedModel, textStep, toolCallStep } from '../../src/harness/scripted-model.js';
import { createMemoryService } from '../../src/memory/service.js';
import { createCoreHarness, type CoreHarness } from '../helpers/core-harness.js';

const LIMITS: TurnLimits = {
  modelCalls: 8,
  toolCalls: 15,
  wallClockMs: 60_000,
  statusChecks: 3,
  retriesPerTool: 2,
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istHour(iso: string): number {
  return new Date(Date.parse(iso) + IST_OFFSET_MS).getUTCHours();
}

/** 10:00 IST on the IST calendar day of `iso`, as an ISO instant. */
function tenAmIst(iso: string): string {
  const ist = new Date(Date.parse(iso) + IST_OFFSET_MS);
  ist.setUTCHours(10, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS).toISOString();
}

describe('same-electrician scenario', () => {
  let h: CoreHarness;

  beforeEach(async () => {
    h = await createCoreHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('S17 same electrician as last time, not before 10 — memory + context', async ({ task }) => {
    task.meta.expected =
      'active memories (preferred electrician, not_before) reach the context and context_log; forgotten and unconfirmed ones do not; the proposal is for the preferred provider at or after 10:00 IST; nothing is booked';

    const date_range = {
      from: h.clock.now().toISOString(),
      to: new Date(h.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const { providers } = await h.client.search_providers(h.userId, {
      service: 'electrician',
      area: 'Indiranagar',
      date_range,
    });
    let preferred: ProviderSummary | undefined;
    let slot: Slot | undefined;
    for (const p of providers) {
      const s = p.slots.find((candidate) => istHour(candidate.start) >= 10);
      if (s !== undefined) {
        preferred = p;
        slot = s;
        break;
      }
    }
    if (preferred === undefined || slot === undefined) throw new Error('no electrician with a slot at/after 10:00 IST');
    h.providerCalls().length = 0;

    const memory = createMemoryService({ db: h.db, clock: h.clock });
    const prefFact = memory.remember(h.userId, {
      key: 'preferred_electrician',
      value: preferred.id,
      kind: 'explicit',
      tags: ['service:electrician'],
    });
    const notBefore = memory.remember(h.userId, {
      key: 'not_before',
      value: '10:00',
      kind: 'explicit',
      tags: ['general'],
    });
    const forgotten = memory.remember(h.userId, {
      key: 'preferred_electrician_old',
      value: 'prv_999',
      kind: 'explicit',
      tags: ['service:electrician'],
    });
    memory.forgetById(h.userId, forgotten.id);
    const unconfirmed = memory.remember(h.userId, {
      key: 'electrician_guess',
      value: 'prv_888',
      kind: 'inferred',
      tags: ['service:electrician'],
    });

    const windowFrom = tenAmIst(slot.start);
    const model = scriptedModel([
      toolCallStep(
        'update_task',
        { service: 'electrician', area: 'Indiranagar', window_from: windowFrom, window_to: date_range.to },
        's17-update',
      ),
      toolCallStep('search_providers', { service: 'electrician', area: 'Indiranagar', date_range }, 's17-search'),
      toolCallStep('propose_booking', { provider_id: preferred.id, service: 'electrician', slot }, 's17-propose'),
      textStep(`Please confirm this proposal with ${preferred.id}, starting after 10 a.m.`),
    ]);

    const result = await runTurn(
      {
        db: h.db,
        clock: h.clock,
        model,
        providerClient: h.client,
        logger: h.logger,
        memory,
        tracesDir: mkdtempSync(path.join(tmpdir(), 'bellhop-trace-')),
        limits: LIMITS,
      },
      { userId: h.userId, text: 'Book the same electrician as last time, but not before 10 a.m.' },
    );

    expect(result.exit).toBe('proposed');

    // Step 0 predates update_task (no service yet), so general facts are present; later steps carry the service tag.
    const logged = memory.listContextLog(h.userId);
    const loggedIds = new Set(logged.flatMap((row) => row.factIds));
    expect(loggedIds.has(prefFact.id)).toBe(true);
    expect(loggedIds.has(notBefore.id)).toBe(true);
    expect(loggedIds.has(forgotten.id)).toBe(false);
    expect(loggedIds.has(unconfirmed.id)).toBe(false);

    // Instructions passed to the model on a later step contain the preferred provider id, never the dead ones.
    const lastPrompt = JSON.stringify(model.doGenerateCalls[model.doGenerateCalls.length - 1]!.prompt);
    expect(lastPrompt).toContain(preferred.id);
    expect(lastPrompt).toContain('not_before');
    expect(lastPrompt).not.toContain('prv_999');
    expect(lastPrompt).not.toContain('prv_888');

    const pending = h.engine.proposals.listPending(h.userId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.provider_id).toBe(preferred.id);
    expect(Date.parse(pending[0]!.slot.start)).toBeGreaterThanOrEqual(Date.parse(windowFrom));
    expect(istHour(pending[0]!.slot.start)).toBeGreaterThanOrEqual(10);

    const approvals = h.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE user_id = ?').get(h.userId) as { n: number };
    expect(approvals.n).toBe(0);
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `preferred=${preferred.id} slot_ist_hour=${istHour(pending[0]!.slot.start)} logged_pref=true logged_not_before=true forgotten_logged=false unconfirmed_logged=false pending=1 approvals=0 bookings=0`;
  });
});
