import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_CONTRACTS, type ToolError, type ToolName } from '@bellhop/shared/contracts';
import { startTestProvider, type TestProvider } from '../../src/testing.js';
import { postTool, postToolAs, pushScenario, TEST_USER } from './helpers.js';

const TOOL_NAMES = Object.keys(TOOL_CONTRACTS) as ToolName[];

describe('tool routes - boundary checks (parameterised over all 8 tools)', () => {
  let tp: TestProvider;

  beforeAll(async () => {
    tp = await startTestProvider();
  });

  afterAll(async () => {
    await tp.close();
  });

  it.each(TOOL_NAMES)('%s -> 401 unauthorized without the x-user-id header', async (toolName) => {
    const { status, body } = await postToolAs<ToolError>(tp, toolName, {}, null);
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  it.each(TOOL_NAMES)('%s -> 400 bad_request with an empty body', async (toolName) => {
    const { status, body } = await postTool<ToolError>(tp, toolName, {});
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.details).toBeDefined();
  });
});

describe('tool routes - happy-path chain over real HTTP', () => {
  let tp: TestProvider;

  beforeAll(async () => {
    tp = await startTestProvider();
  });

  afterAll(async () => {
    await tp.close();
  });

  it('search_providers -> get_provider -> hold_slot -> book -> get_booking_status -> reschedule -> cancel -> list_bookings', async () => {
    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const search = await postTool(tp, 'search_providers', {
      service: 'plumber',
      area: 'Indiranagar',
      date_range: { from, to },
    });
    expect(search.status).toBe(200);
    const searchOutput = TOOL_CONTRACTS.search_providers.output.parse(search.body);
    expect(searchOutput.providers.length).toBeGreaterThan(0);
    const provider = searchOutput.providers[0]!;

    const getProvider = await postTool(tp, 'get_provider', { provider_id: provider.id });
    expect(getProvider.status).toBe(200);
    TOOL_CONTRACTS.get_provider.output.parse(getProvider.body);

    const slot = provider.slots[0]!;
    const hold = await postTool(tp, 'hold_slot', { provider_id: provider.id, slot });
    expect(hold.status).toBe(200);
    const holdOutput = TOOL_CONTRACTS.hold_slot.output.parse(hold.body);

    await pushScenario(tp, ['BOOK_SUCCESS']);
    const idempotencyKey = `chain-${holdOutput.hold.hold_id}`;
    const book = await postTool(tp, 'book', {
      hold_id: holdOutput.hold.hold_id,
      idempotency_key: idempotencyKey,
    });
    expect(book.status).toBe(200);
    const bookOutput = TOOL_CONTRACTS.book.output.parse(book.body);

    const status = await postTool(tp, 'get_booking_status', { idempotency_key: idempotencyKey });
    expect(status.status).toBe(200);
    const statusOutput = TOOL_CONTRACTS.get_booking_status.output.parse(status.body);
    expect(statusOutput.status).toBe('booked');

    const nextSlot = provider.slots[1]!;
    const reschedule = await postTool(tp, 'reschedule', {
      booking_id: bookOutput.booking.booking_id,
      slot: nextSlot,
      idempotency_key: `reschedule-${bookOutput.booking.booking_id}`,
    });
    expect(reschedule.status).toBe(200);
    const rescheduleOutput = TOOL_CONTRACTS.reschedule.output.parse(reschedule.body);
    expect(rescheduleOutput.booking.slot).toEqual(nextSlot);

    await pushScenario(tp, ['CANCEL_OK']);
    const cancel = await postTool(tp, 'cancel', {
      booking_id: bookOutput.booking.booking_id,
      idempotency_key: `cancel-${bookOutput.booking.booking_id}`,
    });
    expect(cancel.status).toBe(200);
    const cancelOutput = TOOL_CONTRACTS.cancel.output.parse(cancel.body);
    expect(cancelOutput.booking.status).toBe('cancelled');

    const list = await postTool(tp, 'list_bookings', { user_id: TEST_USER });
    expect(list.status).toBe(200);
    const listOutput = TOOL_CONTRACTS.list_bookings.output.parse(list.body);
    expect(listOutput.bookings.some((b) => b.booking_id === bookOutput.booking.booking_id)).toBe(true);
  });
});
