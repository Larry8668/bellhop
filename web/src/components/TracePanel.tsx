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
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
        <div>
          <span className="text-sm font-semibold text-zinc-900">Trace</span>
          <span className="ml-2 text-xs text-zinc-400 tabular-nums">{events.length} events</span>
        </div>
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
        className="thin-scroll min-h-0 max-h-[70dvh] flex-1 space-y-1.5 overflow-y-auto p-3 text-xs text-zinc-700 lg:max-h-none"
      >
        {events.length === 0 ? (
          <li className="px-1 py-6 text-center text-zinc-400">No trace events yet.</li>
        ) : (
          events.map((e, i) => {
            const key = `${e.ts}-${i}-${e.type}`;
            const expanded = openDetail[key] === true;
            const hasDetail = e.detail !== undefined;
            return (
              <li key={key} className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-2.5 transition hover:border-zinc-200">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={toneFor(e.type)}>{e.type}</Badge>
                  <span className="ml-auto font-mono text-[10px] text-zinc-400">{e.ts.slice(11, 23) || e.ts}</span>
                </div>
                <div className="mt-1.5 break-words font-mono text-[11px] text-zinc-800">{e.summary}</div>
                {hasDetail ? (
                  <div className="mt-1">
                    <button
                      type="button"
                      className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
                      aria-expanded={expanded}
                      onClick={() =>
                        setOpenDetail((prev) => ({ ...prev, [key]: !expanded }))
                      }
                    >
                      {expanded ? 'Hide detail' : 'Show detail'}
                    </button>
                    {expanded ? (
                      <pre className="thin-scroll mt-1.5 overflow-x-auto rounded-lg bg-zinc-900 p-2.5 font-mono text-[10px] leading-relaxed text-zinc-100">
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
