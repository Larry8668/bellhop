import { afterEach, describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@bellhop/shared/contracts';
import { createCoreHarness, type CoreHarness } from '../helpers/core-harness.js';
import { findProvider, proposeBooking } from '../scenarios/helpers.js';

describe('createCoreEngine', () => {
  let h: CoreHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('forwards its requestId as the request-id header on every engine provider call (hold_slot, book)', async () => {
    h = await createCoreHarness({ requestId: 'req_engine_1' });
    const provider = await findProvider(h);
    const calls = h.providerCalls();

    const result = await h.engine.proposals.proposeBooking(h.userId, { provider_id: provider.id, slot: provider.slots[0]! });
    if (!result.ok) throw new Error(result.code);
    h.scenario('BOOK_SUCCESS');
    const outcome = await h.engine.executor.execute(h.userId, h.approve(result.proposal).id);

    expect(outcome.kind).toBe('booked');
    expect(calls.map((c) => c.tool)).toEqual(['get_provider', 'hold_slot', 'book']);
    for (const call of calls) expect(call.headers[REQUEST_ID_HEADER], call.tool).toBe('req_engine_1');
  });

  it('sends no request-id header when the engine was built without one', async () => {
    h = await createCoreHarness();
    const provider = await findProvider(h);
    await proposeBooking(h, provider);
    const calls = h.providerCalls();

    h.scenario('BOOK_SUCCESS');
    await h.engine.executor.execute(h.userId, h.approve(h.engine.proposals.listPending(h.userId)[0]!).id);

    expect(calls.map((c) => c.tool)).toEqual(['book']);
    expect(calls[0]!.headers[REQUEST_ID_HEADER]).toBeUndefined();
  });
});
