import type { ScenarioName, ToolName } from '@bellhop/shared/contracts';

export interface ScenarioQueue {
  push(outcomes: ScenarioName[]): void;
  take(tool: ToolName): ScenarioName | undefined;
  pending(): ScenarioName[];
  clear(): void;
}

/** Which forced outcomes `take(tool)` will consider for each tool (plan §4). */
const TOOL_SCENARIOS: Record<ToolName, ReadonlySet<ScenarioName>> = {
  search_providers: new Set(['SEARCH_ERROR']),
  get_provider: new Set(),
  hold_slot: new Set(['PRICE_CHANGES_ON_HOLD']),
  book: new Set(['BOOK_SUCCESS', 'BOOK_SLOT_TAKEN', 'TIMEOUT_BOOKED', 'TIMEOUT_NOT_BOOKED', 'HOLD_EXPIRED']),
  get_booking_status: new Set(),
  cancel: new Set(['CANCEL_503_ONCE', 'CANCEL_OK']),
  reschedule: new Set(['RESCHEDULE_CONFLICT']),
  list_bookings: new Set(),
};

/**
 * FIFO queue of forced scenario outcomes, one `/__admin/scenario` push at a
 * time. `take(tool)` scans from the front and removes the first entry that
 * applies to `tool`, wherever it sits in the queue, so unrelated forced
 * outcomes queued earlier for other tools aren't consumed or reordered.
 */
export function createScenarioQueue(): ScenarioQueue {
  let queue: ScenarioName[] = [];

  return {
    push(outcomes: ScenarioName[]): void {
      for (const outcome of outcomes) {
        if (outcome === 'RANDOM') {
          queue = [];
          continue;
        }
        queue.push(outcome);
      }
    },
    take(tool: ToolName): ScenarioName | undefined {
      const applicable = TOOL_SCENARIOS[tool];
      const index = queue.findIndex((outcome) => applicable.has(outcome));
      if (index === -1) return undefined;
      const [outcome] = queue.splice(index, 1);
      return outcome;
    },
    pending(): ScenarioName[] {
      return [...queue];
    },
    clear(): void {
      queue = [];
    },
  };
}
