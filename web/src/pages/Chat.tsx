import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/index.js';
import type { ChatMessage, ProposalDetail, TraceEvent } from '../api/types.js';
import { proposalDetailSchema } from '../api/schemas.js';
import { ApiError } from '../api/client.js';
import { Layout } from '../components/Layout.js';
import { ApprovalCard } from '../components/ApprovalCard.js';
import { TracePanel } from '../components/TracePanel.js';
import { Button } from '../components/Button.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import { log } from '../logger.js';

export function Chat(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<ProposalDetail | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const loadMessages = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await api.listMessages();
      setMessages(list);
    } catch (err) {
      log.error({ err }, 'list messages failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not load messages';
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPendingProposal = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listProposals();
      const candidates = list.filter((p) => p.status === 'pending' && !p.expired);
      if (candidates.length === 0) {
        setPending(null);
        return;
      }
      const next = candidates.reduce((best, p) =>
        p.updated_at >= best.updated_at ? p : best,
      );
      setPending(next);
    } catch (err) {
      log.error({ err }, 'list proposals failed');
    }
  }, []);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    void loadPendingProposal();
  }, [loadPendingProposal]);

  useEffect(() => {
    const off = api.streamEvents((e) => {
      setTrace((prev) => [...prev.slice(-80), e]);

      if (e.type === 'proposal_pending') {
        if (e.detail !== undefined && e.detail !== null) {
          const parsed = proposalDetailSchema.safeParse(e.detail);
          if (parsed.success) {
            setPending(parsed.data);
          }
        }
      } else if (e.type === 'proposal_cleared' || e.type === 'proposal_resolved') {
        setPending(null);
      }
    });
    return off;
  }, []);

  async function handleSend(): Promise<void> {
    const text = input.trim();
    if (!text) return;
    setSendError(null);
    setInput('');
    try {
      await api.sendMessage(text);
      const list = await api.listMessages();
      setMessages(list);
      await loadPendingProposal();
    } catch (err) {
      log.error({ err }, 'send message failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not send message';
      setSendError(message);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!pending) return;
    setActionBusy(true);
    setSendError(null);
    try {
      await api.approve(pending.id, pending.hash);
      setPending(null);
      const list = await api.listMessages();
      setMessages(list);
    } catch (err) {
      log.error({ err }, 'approve failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not confirm';
      setSendError(message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDecline(): Promise<void> {
    if (!pending) return;
    setActionBusy(true);
    setSendError(null);
    try {
      await api.decline(pending.id);
      setPending(null);
      const list = await api.listMessages();
      setMessages(list);
    } catch (err) {
      log.error({ err }, 'decline failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not decline';
      setSendError(message);
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <Layout>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-h-[420px] flex-1 flex-col rounded-xl border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-4 py-3">
            <h1 className="text-lg font-semibold text-zinc-900">Chat</h1>
            <p className="text-xs text-zinc-500">
              Proposals appear here for explicit approval before booking.
            </p>
          </div>

          {loadError ? (
            <div className="p-4">
              <ErrorBanner>{loadError}</ErrorBanner>
              <Button className="mt-3" variant="secondary" onClick={() => void loadMessages()}>
                Retry
              </Button>
            </div>
          ) : null}

          {sendError ? (
            <div className="px-4 pt-4">
              <ErrorBanner>{sendError}</ErrorBanner>
            </div>
          ) : null}

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {loading ? (
              <Spinner label="Loading messages" />
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'ml-auto bg-zinc-900 text-white'
                      : 'mr-auto bg-zinc-100 text-zinc-900'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.text}</p>
                  <p className="mt-1 text-[10px] opacity-70">
                    {new Date(m.createdAt).toLocaleString()}
                  </p>
                </div>
              ))
            )}
          </div>

          {pending ? (
            <div className="border-t border-zinc-100 px-4 py-3">
              <ApprovalCard
                proposal={pending}
                busy={actionBusy}
                onConfirm={() => void handleConfirm()}
                onDecline={() => void handleDecline()}
              />
            </div>
          ) : null}

          <div className="border-t border-zinc-100 p-3">
            <div className="flex gap-2">
              <textarea
                className="min-h-[44px] flex-1 resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                placeholder="Type a message…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <Button className="self-end" onClick={() => void handleSend()}>
                Send
              </Button>
            </div>
          </div>
        </div>

        <div className="w-full shrink-0 lg:w-80">
          <TracePanel events={trace} />
        </div>
      </div>
    </Layout>
  );
}
