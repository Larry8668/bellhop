import { useEffect, useState } from 'react';
import type { ProposalDetail } from '../api/types.js';
import { formatHoldCountdown, formatLocalRange } from '../format.js';
import { Button } from './Button.js';
import { Badge } from './Badge.js';

function useNowMs(frozen: number | undefined): number {
  const [now, setNow] = useState(() => frozen ?? new Date().getTime());
  useEffect(() => {
    if (frozen !== undefined) {
      setNow(frozen);
      return;
    }
    const id = setInterval(() => {
      setNow(new Date().getTime());
    }, 1000);
    return () => clearInterval(id);
  }, [frozen]);
  return frozen ?? now;
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
  nowMs,
}: {
  proposal: ProposalDetail;
  busy?: boolean;
  onConfirm: () => void;
  onDecline: () => void;
  /** Freeze the countdown (tests). Omit to tick once a second. */
  nowMs?: number;
}): React.ReactElement {
  const now = useNowMs(nowMs);
  const countdown = formatHoldCountdown(proposal.hold_expires_at, now);
  let holdLocal = proposal.hold_expires_at;
  const holdDate = new Date(proposal.hold_expires_at);
  if (!Number.isNaN(holdDate.getTime())) holdLocal = holdDate.toLocaleString();

  return (
    <div
      className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm"
      data-testid="approval-card"
    >
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
          <dd className="min-w-0 text-right font-medium">{proposal.provider_name}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-zinc-500">Service</dt>
          <dd className="min-w-0 text-right font-medium">{proposal.service}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="shrink-0 text-zinc-500">Slot (local time)</dt>
          <dd className="min-w-0 text-right font-medium break-words">
            {formatLocalRange(proposal.slot.start, proposal.slot.end)}
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
          <dd className="text-right font-medium">
            <span data-testid="hold-countdown">{countdown}</span>
            <span className="block text-xs font-normal text-zinc-600">{holdLocal}</span>
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
        <Button variant="secondary" disabled={busy} onClick={onDecline}>
          Decline
        </Button>
      </div>
    </div>
  );
}
