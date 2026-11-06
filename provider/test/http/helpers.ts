import {
  ADMIN_PATHS,
  TOOL_CONTRACTS,
  USER_ID_HEADER,
  type AdminScenarioRequest,
  type AdminStateResponse,
  type BookOutput,
  type GetProviderOutput,
  type HoldSlotOutput,
  type ProviderSummary,
  type ScenarioName,
  type Slot,
  type ToolName,
} from '@bellhop/shared/contracts';
import type { TestProvider } from '../../src/testing.js';

export const TEST_USER = 'user_1';
export const OTHER_USER = 'user_2';

export interface HttpResult<T> {
  status: number;
  body: T;
}

/** POSTs a tool route as `TEST_USER` unless a different `userId` is given. */
export async function postTool<T = unknown>(
  tp: TestProvider,
  toolName: ToolName,
  body: unknown,
  userId: string = TEST_USER,
): Promise<HttpResult<T>> {
  return postToolAs<T>(tp, toolName, body, userId);
}

/**
 * Like `postTool`, but a literal `null` for `userId` omits the header
 * entirely — used for the 401 "no `x-user-id`" boundary check. A JS default
 * parameter would otherwise fire for an explicitly-passed `undefined`,
 * silently defeating that test.
 */
export async function postToolAs<T = unknown>(
  tp: TestProvider,
  toolName: ToolName,
  body: unknown,
  userId: string | null,
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (userId !== null) headers[USER_ID_HEADER] = userId;

  const res = await fetch(`${tp.url}${TOOL_CONTRACTS[toolName].path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

export async function pushScenario(
  tp: TestProvider,
  outcomes: ScenarioName[],
  timeoutDelayMs?: number,
): Promise<void> {
  const payload: AdminScenarioRequest =
    timeoutDelayMs === undefined ? { outcomes } : { outcomes, timeout_delay_ms: timeoutDelayMs };
  const res = await fetch(`${tp.url}${ADMIN_PATHS.scenario}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status !== 200) {
    throw new Error(`POST ${ADMIN_PATHS.scenario} failed with ${res.status}`);
  }
}

export async function getAdminState(tp: TestProvider): Promise<HttpResult<AdminStateResponse>> {
  const res = await fetch(`${tp.url}${ADMIN_PATHS.state}`);
  return { status: res.status, body: (await res.json()) as AdminStateResponse };
}

export async function advanceClock(tp: TestProvider, advanceMs: number): Promise<string> {
  const res = await fetch(`${tp.url}${ADMIN_PATHS.clock}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ advance_ms: advanceMs }),
  });
  const body = (await res.json()) as { now: string };
  return body.now;
}

function searchWindow(tp: TestProvider): { from: string; to: string } {
  return {
    from: tp.clock.now().toISOString(),
    to: new Date(tp.clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** Searches, picks the first provider/slot, and returns both plus the raw search body. */
export async function searchFirstProvider(
  tp: TestProvider,
  userId: string = TEST_USER,
): Promise<{ provider: ProviderSummary; slot: Slot }> {
  const { status, body } = await postTool<{ providers: ProviderSummary[] }>(
    tp,
    'search_providers',
    { service: 'plumber', area: 'Indiranagar', date_range: searchWindow(tp) },
    userId,
  );
  if (status !== 200 || body.providers.length === 0) {
    throw new Error('expected at least one provider from search_providers');
  }
  const provider = body.providers[0] as ProviderSummary;
  const slot = provider.slots[0] as Slot;
  return { provider, slot };
}

/** Builds a realistic search → hold chain and returns the resulting hold. */
export async function holdFirstSlot(
  tp: TestProvider,
  userId: string = TEST_USER,
): Promise<HoldSlotOutput['hold'] & { providerSlots: Slot[] }> {
  const { provider, slot } = await searchFirstProvider(tp, userId);
  const { status, body } = await postTool<HoldSlotOutput>(
    tp,
    'hold_slot',
    { provider_id: provider.id, slot },
    userId,
  );
  if (status !== 200) {
    throw new Error(`hold_slot failed with ${status}`);
  }
  return { ...body.hold, providerSlots: provider.slots };
}

/** Forces `BOOK_SUCCESS` and books a fresh hold, for scenarios that need an existing booking. */
export async function bookFirstSlot(
  tp: TestProvider,
  userId: string = TEST_USER,
): Promise<{ booking: BookOutput['booking']; idempotencyKey: string }> {
  const hold = await holdFirstSlot(tp, userId);
  await pushScenario(tp, ['BOOK_SUCCESS']);
  const idempotencyKey = `book-${hold.hold_id}`;
  const { status, body } = await postTool<BookOutput>(
    tp,
    'book',
    { hold_id: hold.hold_id, idempotency_key: idempotencyKey },
    userId,
  );
  if (status !== 200) {
    throw new Error(`book failed with ${status}`);
  }
  return { booking: body.booking, idempotencyKey };
}

export async function getProviderDetail(
  tp: TestProvider,
  providerId: string,
  userId: string = TEST_USER,
): Promise<GetProviderOutput> {
  const { status, body } = await postTool<GetProviderOutput>(
    tp,
    'get_provider',
    { provider_id: providerId },
    userId,
  );
  if (status !== 200) {
    throw new Error(`get_provider failed with ${status}`);
  }
  return body;
}
