import type { Proposal } from '../api/types.js';
import { Button } from './Button.js';

function formatSlot(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    return `${s.toLocaleString()} → ${e.toLocaleString()}`;
  } catch {
    return `${start} → ${end}`;
  }
}

export function ApprovalCard({
  proposal,
  busy,
  onConfirm,
  onDecline,
}: {
  proposal: Proposal;
  busy?: boolean;
  onConfirm: () => void;
  onDecline: () => void;
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-amber-950">Approval needed</h3>
      <p className="mt-1 text-xs text-amber-900">
        Review the exact details below before anything is booked.
      </p>
      <dl className="mt-3 grid gap-2 text-sm text-zinc-900">
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Provider</dt>
          <dd className="font-medium">{proposal.providerName}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Service</dt>
          <dd className="font-medium">{proposal.service}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Slot</dt>
          <dd className="text-right font-medium">
            {formatSlot(proposal.slot.start, proposal.slot.end)}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Price</dt>
          <dd className="font-medium">
            {proposal.price} {proposal.currency}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Expires</dt>
          <dd className="font-medium">
            {new Date(proposal.expiresAt).toLocaleString()}
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={onConfirm}
        >
          Confirm
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={onDecline}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
