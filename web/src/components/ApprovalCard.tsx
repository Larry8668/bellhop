import type { ProposalDetail } from '../api/types.js';
import { Button } from './Button.js';
import { Badge } from './Badge.js';

function formatSlot(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    return `${s.toLocaleString()} → ${e.toLocaleString()}`;
  } catch {
    return `${start} → ${end}`;
  }
}

function actionLabel(a: ProposalDetail['action']): string {
  if (a === 'book') return 'Book';
  if (a === 'cancel') return 'Cancel';
  return 'Reschedule';
}

export function ApprovalCard({
  proposal,
  busy,
  onConfirm,
  onDecline,
}: {
  proposal: ProposalDetail;
  busy?: boolean;
  onConfirm: () => void;
  onDecline: () => void;
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-amber-950">Approval needed</h3>
        {proposal.expired ? (
          <Badge tone="danger" title="Expired">
            Expired
          </Badge>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-amber-900">
        Review the exact details below before anything is booked.
      </p>
      <dl className="mt-3 grid gap-2 text-sm text-zinc-900">
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Action</dt>
          <dd className="font-medium">{actionLabel(proposal.action)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Provider</dt>
          <dd className="font-medium">{proposal.provider_name}</dd>
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
          <dt className="text-zinc-500">Hold expires</dt>
          <dd className="font-medium">
            {new Date(proposal.hold_expires_at).toLocaleString()}
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || proposal.expired}
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
