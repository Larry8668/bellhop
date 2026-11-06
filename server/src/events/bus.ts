/**
 * In-process fan-out for the live trace panel (plan §13, §14). Not a source
 * of truth: a restart drops subscribers, and anything that must survive
 * lives in `messages` and the trace files. One listener set per user, so a
 * publish never crosses users.
 */
export interface BusEvent {
  ts: string;
  type: string;
  summary: string;
  detail?: unknown;
}

export type BusListener = (event: BusEvent) => void;

export interface EventBus {
  publish(userId: string, event: BusEvent): void;
  subscribe(userId: string, fn: BusListener): () => void;
}

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<BusListener>>();

  return {
    publish(userId, event) {
      const set = listeners.get(userId);
      if (set === undefined) return;
      for (const fn of [...set]) fn(event);
    },

    subscribe(userId, fn) {
      const set = listeners.get(userId) ?? new Set<BusListener>();
      set.add(fn);
      listeners.set(userId, set);
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(userId);
      };
    },
  };
}
