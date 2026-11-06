import { useState } from 'react';
import type { TraceEvent } from '../api/types.js';
import { Button } from './Button.js';

export function TracePanel({
  events,
}: {
  events: TraceEvent[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
        <span className="text-sm font-medium text-zinc-900">Trace</span>
        <Button variant="ghost" className="!py-1" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
      {open ? (
        <ul className="max-h-64 space-y-2 overflow-auto p-3 text-xs text-zinc-700">
          {events.length === 0 ? (
            <li className="text-zinc-400">No trace events yet.</li>
          ) : (
            events.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="rounded border border-zinc-100 bg-zinc-50 p-2">
                <div className="font-mono text-[10px] text-zinc-400">
                  {e.ts} · {e.type}
                </div>
                <div className="mt-1 font-medium text-zinc-900">{e.summary}</div>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
