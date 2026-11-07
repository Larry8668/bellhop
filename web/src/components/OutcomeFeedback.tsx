import type { ExecutionOutcome } from '../api/types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function slotAlternatives(outcome: ExecutionOutcome): unknown {
  if (!isRecord(outcome)) return undefined;
  return outcome.alternatives;
}

export function OutcomeFeedback({
  feedback,
}: {
  feedback: { message: string; outcome: ExecutionOutcome };
}): React.ReactElement {
  return (
    <div className="space-y-2">
      {feedback.outcome.kind === 'unconfirmed' ? (
        <div
          className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-sm"
          role="status"
        >
          <p className="font-medium">Unconfirmed</p>
          <p className="mt-0.5">{feedback.message}</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-white px-4 py-3 text-sm text-zinc-800 shadow-sm">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-emerald-700">
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
            Verified outcome
          </p>
          <p className="mt-1 font-semibold capitalize text-zinc-900">
            {feedback.outcome.kind.replace(/_/g, ' ')}
          </p>
          <p className="mt-0.5">{feedback.message}</p>
        </div>
      )}
      {feedback.outcome.kind === 'slot_gone' ? (
        <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-800 shadow-sm">
          <p className="font-medium">Alternatives</p>
          {Array.isArray(slotAlternatives(feedback.outcome)) ? (
            <ul className="mt-1 list-inside list-disc">
              {(slotAlternatives(feedback.outcome) as { start: string; end: string }[]).map(
                (alt, i) => (
                  <li key={`${alt.start}-${i}`}>
                    {new Date(alt.start).toLocaleString()} →{' '}
                    {new Date(alt.end).toLocaleString()}
                  </li>
                ),
              )}
            </ul>
          ) : (
            <p className="mt-1 text-zinc-600">
              No structured alternatives — check the message above.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
