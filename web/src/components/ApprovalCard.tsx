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

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'Provider', value: proposal.provider_name },
    { label: 'Service', value: proposal.service },
    { label: 'Slot (local time)', value: formatLocalRange(proposal.slot.start, proposal.slot.end) },
  ];

  return (
    <div
      className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_8px_30px_rgb(0,0,0,0.06)]"
      data-testid="approval-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-100 bg-gradient-to-r from-amber-50 to-white px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-full bg-amber-100 text-amber-700" aria-hidden>
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Approval needed</h3>
            <p className="text-xs text-zinc-500">Review the exact details below before anything is booked.</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge tone="accent">{actionLabel(proposal.action)}</Badge>
          {proposal.expired ? (
            <Badge tone="danger" title="Expired">
              Expired
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-[1fr_auto]">
        <dl className="grid gap-2.5 text-sm">
          <div className="sr-only">
            <dt>Action</dt>
            <dd>{actionLabel(proposal.action)}</dd>
          </div>
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-[8.5rem_1fr] gap-2">
              <dt className="text-zinc-500">{r.label}</dt>
              <dd className="min-w-0 font-medium break-words text-zinc-900">{r.value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-row items-end justify-between gap-4 rounded-xl bg-zinc-50 px-4 py-3 sm:flex-col sm:items-end sm:justify-center">
          <div className="sm:text-right">
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Price</p>
            <p className="text-xl font-semibold tabular-nums text-zinc-900">
              {proposal.price} {proposal.currency}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Hold expires</p>
            <p className="text-sm font-semibold tabular-nums text-amber-700">
              <span data-testid="hold-countdown">{countdown}</span>
            </p>
            <span className="block text-[11px] text-zinc-500">{holdLocal}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 bg-zinc-50/60 px-4 py-3">
        <Button variant="primary" disabled={busy || proposal.expired} onClick={onConfirm}>
          Confirm
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onDecline}>
          Decline
        </Button>
        <span className="ml-auto hidden text-[11px] text-zinc-400 sm:inline">Price is the provider&apos;s held price</span>
      </div>
    </div>
  );
}
