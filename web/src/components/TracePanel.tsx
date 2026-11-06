import { useEffect, useRef, useState } from 'react';
import type { TraceEvent } from '../api/types.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';

const TYPE_TONE = {
  state_transition: 'info',
  model_call: 'accent',
  tool_call: 'info',
  approval: 'warning',
  intent: 'success',
  error: 'danger',
  proactive: 'warning',
  turn_end: 'success',
} as const;

type Tone = (typeof TYPE_TONE)[keyof typeof TYPE_TONE] | 'default';

function toneFor(type: string): Tone {
  if (Object.prototype.hasOwnProperty.call(TYPE_TONE, type)) {
    return TYPE_TONE[type as keyof typeof TYPE_TONE];
  }
  return 'default';
}

function formatDetail(detail: unknown): string {
  try {
    return JSON.stringify(detail, null, 2) ?? 'null';
  } catch {
    return 'Could not display detail';
  }
}

export function TracePanel({
  events,
  onClear,
}: {
  events: TraceEvent[];
  onClear: () => void;
}): React.ReactElement {
  const [openDetail, setOpenDetail] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [events]);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
        <span className="text-sm font-medium text-zinc-900">Trace</span>
        <Button
          variant="ghost"
          className="!py-1"
          onClick={onClear}
          disabled={events.length === 0}
        >
          Clear
        </Button>
      </div>
      <ul
        ref={listRef}
        aria-label="Trace events"
        className="max-h-80 space-y-2 overflow-y-auto p-3 text-xs text-zinc-700"
      >
        {events.length === 0 ? (
          <li className="text-zinc-400">No trace events yet.</li>
        ) : (
          events.map((e, i) => {
            const key = `${e.ts}-${i}-${e.type}`;
            const expanded = openDetail[key] === true;
            const hasDetail = e.detail !== undefined;
            return (
              <li key={key} className="rounded border border-zinc-100 bg-zinc-50 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={toneFor(e.type)}>{e.type}</Badge>
                  <span className="font-mono text-[10px] text-zinc-400">{e.ts}</span>
                </div>
                <div className="mt-1 font-medium text-zinc-900">{e.summary}</div>
                {hasDetail ? (
                  <div className="mt-1">
                    <button
                      type="button"
                      className="text-[11px] font-medium text-zinc-600 underline"
                      aria-expanded={expanded}
                      onClick={() =>
                        setOpenDetail((prev) => ({ ...prev, [key]: !expanded }))
                      }
                    >
                      {expanded ? 'Hide detail' : 'Show detail'}
                    </button>
                    {expanded ? (
                      <pre className="mt-1 overflow-x-auto rounded bg-white p-2 font-mono text-[10px] text-zinc-800">
                        {formatDetail(e.detail)}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
