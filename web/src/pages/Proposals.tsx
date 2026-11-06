import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../api/index.js';
import type { ExecutionOutcome, ProposalDetail } from '../api/types.js';
import { ApiError } from '../api/client.js';
import { KNOWN_BOOKING_SERVICES } from '../constants/bookingServices.js';
import { Layout } from '../components/Layout.js';
import { ApprovalCard } from '../components/ApprovalCard.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import { Button } from '../components/Button.js';
import { log } from '../logger.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function slotAlternatives(outcome: ExecutionOutcome): unknown {
  if (!isRecord(outcome)) return undefined;
  return outcome.alternatives;
}

function OutcomeFeedback({
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
          <p className="font-medium capitalize">
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
                  <li key={i}>
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

export function Proposals(): React.ReactElement {
  const { id: highlightId } = useParams<{ id?: string }>();
  const [items, setItems] = useState<ProposalDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcomeById, setOutcomeById] = useState<
    Record<string, { message: string; outcome: ExecutionOutcome }>
  >({});

  const [formProviderId, setFormProviderId] = useState('');
  const [formService, setFormService] = useState<string>(KNOWN_BOOKING_SERVICES[0]);
  const [formServiceOther, setFormServiceOther] = useState('');
  const [formSlotStart, setFormSlotStart] = useState('');
  const [formSlotEnd, setFormSlotEnd] = useState('');
  const [formBusy, setFormBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await api.listProposals();
      setItems(list);
    } catch (err) {
      log.error({ err }, 'list proposals failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not load proposals';
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(
    () => items.filter((p) => p.status === 'pending'),
    [items],
  );

  const detachedOutcomes = useMemo(() => {
    const pendingIds = new Set(pending.map((p) => p.id));
    return Object.entries(outcomeById).filter(([id]) => !pendingIds.has(id));
  }, [outcomeById, pending]);

  async function handleApprove(proposal: ProposalDetail): Promise<void> {
    setActionError(null);
    setBusyId(proposal.id);
    try {
      const res = await api.approve(proposal.id, proposal.hash);
      setOutcomeById((prev) => ({
        ...prev,
        [proposal.id]: { message: res.message, outcome: res.outcome },
      }));
      if (res.outcome.kind === 'needs_reapproval') {
        await load();
      } else {
        setItems((prev) => prev.filter((p) => p.id !== proposal.id));
      }
    } catch (err) {
      log.error({ err }, 'approve failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not approve';
      setActionError(message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDecline(proposalId: string): Promise<void> {
    setActionError(null);
    setBusyId(proposalId);
    try {
      await api.decline(proposalId);
      setItems((prev) => prev.filter((p) => p.id !== proposalId));
      setOutcomeById((prev) => {
        const next = { ...prev };
        delete next[proposalId];
        return next;
      });
    } catch (err) {
      log.error({ err }, 'decline failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not decline';
      setActionError(message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleCreateDevProposal(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setActionError(null);
    setFormBusy(true);
    const service =
      formService === '__other__' ? formServiceOther.trim() : formService;
    if (!formProviderId.trim() || !service) {
      setActionError('Provider id and service are required.');
      setFormBusy(false);
      return;
    }
    if (!formSlotStart || !formSlotEnd) {
      setActionError('Slot start and end are required.');
      setFormBusy(false);
      return;
    }
    try {
      await api.createProposal({
        action: 'book',
        provider_id: formProviderId.trim(),
        service,
        slot: {
          start: new Date(formSlotStart).toISOString(),
          end: new Date(formSlotEnd).toISOString(),
        },
      });
      await load();
      setFormProviderId('');
      setFormServiceOther('');
    } catch (err) {
      log.error({ err }, 'create proposal failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not create proposal';
      setActionError(message);
    } finally {
      setFormBusy(false);
    }
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Proposals</h1>
          <p className="text-sm text-zinc-600">
            Pending actions need your approval before anything runs.
          </p>
        </div>

        {loadError ? <ErrorBanner>{loadError}</ErrorBanner> : null}
        {actionError ? <ErrorBanner>{actionError}</ErrorBanner> : null}

        {loading ? (
          <Spinner label="Loading proposals" />
        ) : (
          <>
            {pending.length === 0 && detachedOutcomes.length === 0 ? (
              <p className="text-sm text-zinc-500">No pending proposals.</p>
            ) : null}
            {pending.length > 0 ? (
              <ul className="space-y-4">
                {pending.map((p) => {
                  const feedback = outcomeById[p.id];
                  const highlight = highlightId !== undefined && p.id === highlightId;
                  return (
                    <li
                      key={p.id}
                      id={`proposal-${p.id}`}
                      className={
                        highlight
                          ? 'rounded-xl ring-2 ring-amber-400 ring-offset-2'
                          : undefined
                      }
                    >
                      <ApprovalCard
                        proposal={p}
                        busy={busyId === p.id}
                        onConfirm={() => void handleApprove(p)}
                        onDecline={() => void handleDecline(p.id)}
                      />
                      {feedback ? <OutcomeFeedback feedback={feedback} /> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {detachedOutcomes.length > 0 ? (
              <ul className="mt-4 space-y-4">
                {detachedOutcomes.map(([id, feedback]) => (
                  <li key={`outcome-${id}`} id={`proposal-${id}`}>
                    <OutcomeFeedback feedback={feedback} />
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}

        <section className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-4">
          <h2 className="text-sm font-semibold text-zinc-900">New proposal (dev)</h2>
          <form className="mt-3 space-y-3" onSubmit={(e) => void handleCreateDevProposal(e)}>
            <label className="flex flex-col gap-1 text-xs text-zinc-600">
              Provider id
              <input
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900"
                value={formProviderId}
                onChange={(e) => setFormProviderId(e.target.value)}
                placeholder="prov-123"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-600">
              Service
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <select
                  className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900"
                  value={formService}
                  onChange={(e) => setFormService(e.target.value)}
                >
                  {KNOWN_BOOKING_SERVICES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                  <option value="__other__">Other…</option>
                </select>
                {formService === '__other__' ? (
                  <input
                    className="flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900"
                    value={formServiceOther}
                    onChange={(e) => setFormServiceOther(e.target.value)}
                    placeholder="Custom service"
                  />
                ) : null}
              </div>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-zinc-600">
                Slot start
                <input
                  type="datetime-local"
                  className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900"
                  value={formSlotStart}
                  onChange={(e) => setFormSlotStart(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-600">
                Slot end
                <input
                  type="datetime-local"
                  className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900"
                  value={formSlotEnd}
                  onChange={(e) => setFormSlotEnd(e.target.value)}
                />
              </label>
            </div>
            <Button type="submit" disabled={formBusy}>
              Create proposal
            </Button>
          </form>
        </section>
      </div>
    </Layout>
  );
}
