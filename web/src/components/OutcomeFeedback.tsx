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
    <div className="mt-3 space-y-2">
      {feedback.outcome.kind === 'unconfirmed' ? (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
          role="status"
        >
          <p className="font-medium">Unconfirmed</p>
          <p className="mt-0.5">{feedback.message}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Verified outcome
          </p>
          <p className="mt-1 font-medium capitalize">
            {feedback.outcome.kind.replace(/_/g, ' ')}
          </p>
          <p className="mt-0.5">{feedback.message}</p>
        </div>
      )}
      {feedback.outcome.kind === 'slot_gone' ? (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800">
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
