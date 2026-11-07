import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/index.js';
import type { ChatMessage, ExecutionOutcome, ProposalDetail, TaskState, TraceEvent } from '../api/types.js';
import { BrandMark, Layout } from '../components/Layout.js';
import { Markdown } from '../components/Markdown.js';
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

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const empty = !loading && !loadError && messages.length === 0 && !pending;

  return (
    <Layout fill>
      <div className="relative flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-zinc-200/60 bg-white/60 backdrop-blur-sm">
            <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-2">
              <div className="min-w-0 [&_[data-testid=task-chip]]:mt-0">
                <TaskChip task={task} />
              </div>
              <Button
                variant={traceOpen ? 'secondary' : 'ghost'}
                className="shrink-0 !px-3 !py-1.5 !text-xs"
                aria-pressed={traceOpen}
                onClick={() => setTraceOpen((v) => !v)}
              >
                <TraceIcon />
                {traceOpen ? 'Hide trace' : 'Trace'}
              </Button>
            </div>
          </div>

          <div ref={listRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto" aria-label="Conversation">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-6 pt-8">
              {loadError ? (
                <div>
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

              {loading ? <Spinner label="Loading messages" /> : null}

              {empty ? <EmptyState onPick={(t) => { setInput(t); textareaRef.current?.focus(); }} /> : null}

              {!loading
                ? messages.map((m) => <MessageRow key={m.id} message={m} />)
                : null}

              {sending ? (
                <div className="flex gap-3 animate-rise">
                  <BrandMark className="size-7 shrink-0" />
                  <div className="pt-1">
                    <Spinner label="Bellhop is working…" />
                  </div>
                </div>
              ) : null}

              {proactiveNotice ? (
                <div
                  className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-950 shadow-sm animate-rise"
                  role="status"
                >
                  <span className="mt-1 size-2 shrink-0 animate-pulse rounded-full bg-amber-500" aria-hidden />
                  <p className="flex-1">{proactiveNotice}</p>
                  <Button
                    variant="ghost"
                    className="!px-2 !py-0.5 !text-xs"
                    onClick={() => setProactiveNotice(null)}
                  >
                    Dismiss
                  </Button>
                </div>
              ) : null}

              {verified ? (
                <div className="pl-10 animate-rise">
                  <OutcomeFeedback feedback={verified} />
                </div>
              ) : null}

              {pending ? (
                <div id="approval-card" className="pl-0 sm:pl-10 animate-rise">
                  <ApprovalCard
                    proposal={pending}
                    busy={actionBusy}
                    onConfirm={() => void handleConfirm()}
                    onDecline={() => void handleDecline()}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div className="bg-gradient-to-t from-[#fafaf9] via-[#fafaf9] to-transparent pt-2">
            <div className="mx-auto w-full max-w-3xl px-4 pb-4">
              {sendError ? (
                <div className="mb-2">
                  <ErrorBanner>{sendError}</ErrorBanner>
                </div>
              ) : null}
              <div className="flex items-end gap-2 rounded-3xl border border-zinc-200 bg-white p-2 pl-4 shadow-[0_8px_30px_rgb(0,0,0,0.06)] transition focus-within:border-zinc-300 focus-within:shadow-[0_8px_30px_rgb(0,0,0,0.1)]">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  className="max-h-[200px] min-h-[40px] w-full flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:text-zinc-400"
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
                <button
                  type="button"
                  aria-label="Send"
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white shadow-sm transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
                  disabled={sending || input.trim() === ''}
                  onClick={() => void handleSend()}
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                </button>
              </div>
              <p className="mt-2 text-center text-[11px] text-zinc-400">
                Bellhop only proposes. Nothing is booked until you confirm the card.
              </p>
            </div>
          </div>
        </section>

        {traceOpen ? (
          <aside className="absolute inset-y-0 right-0 z-10 flex w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-xl lg:static lg:w-[26rem] lg:shadow-none">
            <TracePanel events={trace} onClear={() => setTrace([])} />
          </aside>
        ) : null}
      </div>
    </Layout>
  );
}

const SUGGESTIONS = [
  'Find a plumber for my kitchen tap this week, mornings only, under ₹1,500 in Indiranagar',
  'Book an electrician in Koramangala tomorrow afternoon',
  'Show my upcoming bookings',
  'Move my AC servicing to Saturday',
];

function EmptyState({ onPick }: { onPick: (text: string) => void }): React.ReactElement {
  return (
    <div className="flex flex-col items-center pt-[8vh] text-center animate-rise">
      <BrandMark className="size-12 rounded-2xl" />
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-zinc-900">What can I sort out for you?</h1>
      <p className="mt-2 max-w-md text-sm text-zinc-500">
        Plumbers, electricians, AC servicing. I find the options and hold a slot, and you approve before anything is booked.
      </p>
      <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-left text-sm text-zinc-700 shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageRow({ message: m }: { message: ChatMessage }): React.ReactElement {
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (m.role === 'system') {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-500">{m.text}</span>
      </div>
    );
  }
  if (m.role === 'user') {
    return (
      <div className="group flex flex-col items-end animate-rise">
        <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-zinc-900 px-4 py-2.5 text-[15px] leading-6 text-white shadow-sm">
          <p className="whitespace-pre-wrap">{m.text}</p>
        </div>
        <span className="mt-1 pr-2 text-[10px] text-zinc-400 opacity-0 transition group-hover:opacity-100">{time}</span>
      </div>
    );
  }
  return (
    <div className="group flex gap-3 animate-rise">
      <BrandMark className="mt-0.5 size-7 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-900">Bellhop</span>
          <span className="text-[10px] text-zinc-400 opacity-0 transition group-hover:opacity-100">{time}</span>
        </div>
        <Markdown text={m.text} />
        {m.proposalId ? (
          <a
            href="#approval-card"
            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200 transition hover:bg-amber-100"
          >
            <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
            see approval card
          </a>
        ) : null}
      </div>
    </div>
  );
}

function TraceIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    </svg>
  );
}
