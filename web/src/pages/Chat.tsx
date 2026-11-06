import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/index.js';
import type { ChatMessage, ExecutionOutcome, ProposalDetail, TaskState, TraceEvent } from '../api/types.js';
import { Layout } from '../components/Layout.js';
import { ApprovalCard } from '../components/ApprovalCard.js';
import { TracePanel } from '../components/TracePanel.js';
import { TaskChip } from '../components/TaskChip.js';
import { OutcomeFeedback } from '../components/OutcomeFeedback.js';
import { Button } from '../components/Button.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import { log } from '../logger.js';
import { errorMessage } from '../uiError.js';

const PROVIDER_CANCEL_NOTICE =
  'Your booking was cancelled by the provider — we found a replacement';

function pickPending(list: ProposalDetail[]): ProposalDetail | null {
  const candidates = list.filter((p) => p.status === 'pending' && !p.expired);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, p) => (p.updated_at >= best.updated_at ? p : best));
}

function bubbleClass(role: ChatMessage['role']): string {
  if (role === 'user') return 'ml-auto max-w-[85%] bg-zinc-900 text-white';
  if (role === 'system') return 'mx-auto max-w-full bg-transparent text-center text-xs text-zinc-500';
  return 'mr-auto max-w-[85%] bg-zinc-100 text-zinc-900';
}

function roleLabel(role: ChatMessage['role']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Bellhop';
  return 'System';
}

export function Chat(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<ProposalDetail | null>(null);
  const [task, setTask] = useState<TaskState | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [traceOpen, setTraceOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [proactiveNotice, setProactiveNotice] = useState<string | null>(null);
  const [verified, setVerified] = useState<{ message: string; outcome: ExecutionOutcome } | null>(
    null,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  const refreshLive = useCallback(async (): Promise<void> => {
    const [list, nextTask, proposals] = await Promise.all([
      api.listMessages(),
      api.getTask(),
      api.listProposals(),
    ]);
    if (!alive.current) return;
    setMessages(list);
    setTask(nextTask);
    setPending(pickPending(proposals));
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, sending, pending, verified, proactiveNotice]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const [list, nextTask, proposals] = await Promise.all([
          api.listMessages(),
          api.getTask(),
          api.listProposals(),
        ]);
        if (cancelled) return;
        setMessages(list);
        setTask(nextTask);
        setPending(pickPending(proposals));
      } catch (err) {
        log.error({ err }, 'chat load failed');
        if (!cancelled) setLoadError(errorMessage(err, 'Could not load messages'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const off = api.streamEvents((e) => {
      setTrace((prev) => [...prev.slice(-200), e]);
      if (e.type !== 'proactive') return;
      setProactiveNotice(PROVIDER_CANCEL_NOTICE);
      void refreshLive().catch((err: unknown) => {
        log.error({ err }, 'proactive refresh failed');
        if (alive.current) {
          setSendError(errorMessage(err, 'Could not refresh after the provider cancellation'));
        }
      });
    });
    return off;
  }, [refreshLive]);

  async function handleSend(): Promise<void> {
    const text = input.trim();
    if (!text || sending) return;
    const localId = `local-${crypto.randomUUID()}`;
    setSendError(null);
    setInput('');
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { id: localId, role: 'user', text, createdAt: new Date().toISOString() },
    ]);
    try {
      const assistant = await api.sendMessage(text);
      try {
        await refreshLive();
      } catch (err) {
        log.error({ err }, 'refresh after send failed');
        setSendError(errorMessage(err, 'Could not refresh messages'));
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== localId),
          { id: `${localId}-user`, role: 'user', text, createdAt: new Date().toISOString() },
          assistant,
        ]);
      }
    } catch (err) {
      log.error({ err }, 'send message failed');
      setMessages((prev) => prev.filter((m) => m.id !== localId));
      setInput(text);
      setSendError(errorMessage(err, 'Could not send message'));
    } finally {
      setSending(false);
    }
  }

  async function refreshBookingsToo(): Promise<void> {
    const [live, bookingsResult] = await Promise.allSettled([
      refreshLive(),
      api.listBookings(),
    ]);
    const err =
      live.status === 'rejected'
        ? live.reason
        : bookingsResult.status === 'rejected'
          ? bookingsResult.reason
          : null;
    if (err !== null) {
      log.error({ err }, 'refresh after approval failed');
      setSendError(errorMessage(err, 'Could not refresh after approval'));
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!pending || actionBusy) return;
    setActionBusy(true);
    setSendError(null);
    try {
      const res = await api.approve(pending.id, pending.hash);
      setVerified({ message: res.message, outcome: res.outcome });
      await refreshBookingsToo();
    } catch (err) {
      log.error({ err }, 'approve failed');
      setSendError(errorMessage(err, 'Could not confirm'));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDecline(): Promise<void> {
    if (!pending || actionBusy) return;
    setActionBusy(true);
    setSendError(null);
    try {
      await api.decline(pending.id);
      setVerified(null);
      await refreshLive();
    } catch (err) {
      log.error({ err }, 'decline failed');
      setSendError(errorMessage(err, 'Could not decline'));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <Layout>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col rounded-xl border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold text-zinc-900">Chat</h1>
                <p className="text-xs text-zinc-500">
                  Proposals appear here for explicit approval before booking.
                </p>
                <TaskChip task={task} />
              </div>
              <Button
                variant={traceOpen ? 'secondary' : 'ghost'}
                className="shrink-0"
                aria-pressed={traceOpen}
                onClick={() => setTraceOpen((v) => !v)}
              >
                {traceOpen ? 'Hide trace' : 'Trace'}
              </Button>
            </div>
          </div>

          {loadError ? (
            <div className="p-4">
              <ErrorBanner>{loadError}</ErrorBanner>
              <Button
                className="mt-3"
                variant="secondary"
                onClick={() => {
                  setLoading(true);
                  setLoadError(null);
                  void refreshLive()
                    .catch((err: unknown) => {
                      log.error({ err }, 'chat reload failed');
                      setLoadError(errorMessage(err, 'Could not load messages'));
                    })
                    .finally(() => setLoading(false));
                }}
              >
                Retry
              </Button>
            </div>
          ) : null}

          {sendError ? (
            <div className="px-4 pt-4">
              <ErrorBanner>{sendError}</ErrorBanner>
            </div>
          ) : null}

          <div
            ref={listRef}
            className="max-h-[50dvh] min-h-[12rem] flex-1 space-y-3 overflow-y-auto px-4 py-3"
            aria-label="Conversation"
          >
            {loading ? (
              <Spinner label="Loading messages" />
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`rounded-lg px-3 py-2 text-sm ${bubbleClass(m.role)}`}>
                  <p className="text-[10px] font-medium uppercase tracking-wide opacity-70">
                    {roleLabel(m.role)}
                  </p>
                  <p className="whitespace-pre-wrap">{m.text}</p>
                  {m.proposalId ? (
                    <a
                      href="#approval-card"
                      className="mt-2 inline-block rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-950"
                    >
                      see approval card
                    </a>
                  ) : null}
                  <p className="mt-1 text-[10px] opacity-70">
                    {new Date(m.createdAt).toLocaleString()}
                  </p>
                </div>
              ))
            )}
          </div>

          {sending ? (
            <div className="px-4 pb-2">
              <Spinner label="Bellhop is working…" />
            </div>
          ) : null}

          {proactiveNotice ? (
            <div
              className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
              role="status"
            >
              <p>{proactiveNotice}</p>
              <Button
                variant="ghost"
                className="mt-2 !px-2 !py-1 !text-xs"
                onClick={() => setProactiveNotice(null)}
              >
                Dismiss
              </Button>
            </div>
          ) : null}

          {verified ? (
            <div className="border-t border-zinc-100 px-4 py-3">
              <OutcomeFeedback feedback={verified} />
            </div>
          ) : null}

          {pending ? (
            <div id="approval-card" className="border-t border-zinc-100 px-4 py-3">
              <ApprovalCard
                proposal={pending}
                busy={actionBusy}
                onConfirm={() => void handleConfirm()}
                onDecline={() => void handleDecline()}
              />
            </div>
          ) : null}

          <div className="border-t border-zinc-100 p-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <textarea
                className="min-h-[44px] w-full flex-1 resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-100"
                placeholder="Type a message…"
                value={input}
                disabled={sending}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <Button
                className="sm:self-end"
                disabled={sending || input.trim() === ''}
                onClick={() => void handleSend()}
              >
                Send
              </Button>
            </div>
          </div>
        </div>

        {traceOpen ? (
          <div className="w-full shrink-0 lg:w-96">
            <TracePanel events={trace} onClear={() => setTrace([])} />
          </div>
        ) : null}
      </div>
    </Layout>
  );
}
