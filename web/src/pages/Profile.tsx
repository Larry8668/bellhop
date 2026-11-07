import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api/index.js';
import type { ApiKey, CreateApiKeyResult, Fact } from '../api/types.js';
import { useSession } from '../auth/SessionProvider.js';
import { Layout } from '../components/Layout.js';
import { Button } from '../components/Button.js';
import { Badge } from '../components/Badge.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import { log } from '../logger.js';
import { mcpConfigSnippet } from '../mcpConfig.js';
import { errorMessage } from '../uiError.js';

function FactCard({
  fact,
  draft,
  busy,
  onDraft,
  onSave,
  onForget,
  onConfirm,
}: {
  fact: Fact;
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
  onForget: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  const dirty = draft !== fact.value;
  return (
    <li aria-label={fact.key} className="p-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700">
          {fact.key}
        </span>
        <div className="flex items-center gap-1.5">
          <Badge tone={fact.kind === 'explicit' ? 'accent' : 'warning'}>{fact.kind}</Badge>
          <Badge tone={fact.status === 'active' ? 'success' : 'default'}>{fact.status}</Badge>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 min-w-0 flex-1"
          value={draft}
          aria-label={`Value for ${fact.key}`}
          onChange={(e) => onDraft(e.target.value)}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="secondary"
            className="!px-3 !py-1.5 !text-xs"
            disabled={busy}
            onClick={onSave}
          >
            Save
          </Button>
          {fact.status === 'unconfirmed' ? (
            <Button
              variant="primary"
              className="!px-3 !py-1.5 !text-xs"
              disabled={busy}
              onClick={onConfirm}
            >
              Confirm
            </Button>
          ) : null}
          <Button
            variant="ghost"
            className="!px-3 !py-1.5 !text-xs hover:!bg-rose-50 hover:!text-rose-700"
            disabled={busy}
            onClick={onForget}
          >
            Forget
          </Button>
          {dirty ? <span className="text-[11px] text-zinc-400">Unsaved</span> : null}
        </div>
      </div>
    </li>
  );
}

const SECTION_LABEL = 'text-xs font-medium uppercase tracking-wide text-zinc-500';
const CARD = 'rounded-2xl border border-zinc-200/80 bg-white shadow-sm';

export function Profile(): React.ReactElement {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (!hasLoaded.current) setLoading(true);
    setError(null);
    try {
      const [f, k] = await Promise.all([api.listFacts(), api.listApiKeys()]);
      setFacts(f);
      setKeys(k);
      const nextDrafts: Record<string, string> = {};
      for (const fact of f) {
        nextDrafts[fact.id] = fact.value;
      }
      setDrafts(nextDrafts);
      hasLoaded.current = true;
    } catch (err) {
      log.error({ err }, 'profile load failed');
      setError(errorMessage(err, 'Could not load profile data'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveFact(id: string): Promise<void> {
    const value = drafts[id];
    if (value === undefined) return;
    setBusyId(id);
    setError(null);
    try {
      await api.updateFact(id, value);
      await load();
    } catch (err) {
      log.error({ err, factId: id }, 'update fact failed');
      setError(errorMessage(err, 'Could not update fact'));
    } finally {
      setBusyId(null);
    }
  }

  async function forgetFact(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await api.forgetFact(id);
      await load();
    } catch (err) {
      log.error({ err, factId: id }, 'forget fact failed');
      setError(errorMessage(err, 'Could not forget fact'));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmFact(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await api.confirmFact(id);
      await load();
    } catch (err) {
      log.error({ err, factId: id }, 'confirm fact failed');
      setError(errorMessage(err, 'Could not confirm fact'));
    } finally {
      setBusyId(null);
    }
  }

  async function onCreateKey(e: FormEvent): Promise<void> {
    e.preventDefault();
    const name = newKeyName.trim();
    if (!name) return;
    setError(null);
    setBusyId('new-key');
    try {
      const created: CreateApiKeyResult = await api.createApiKey(name);
      setPlaintextKey(created.plaintextKey);
      setNewKeyName('');
      await load();
    } catch (err) {
      log.error({ err }, 'create api key failed');
      setError(errorMessage(err, 'Could not create API key'));
    } finally {
      setBusyId(null);
    }
  }

  async function copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      log.error({ err }, 'clipboard write failed');
      setError('Could not copy to clipboard');
    }
  }

  const active = facts.filter((f) => f.status === 'active');
  const needsConfirmation = facts.filter((f) => f.status === 'unconfirmed');
  const snippet = plaintextKey ? mcpConfigSnippet(plaintextKey) : null;

  function renderFact(fact: Fact): React.ReactElement {
    return (
      <FactCard
        key={fact.id}
        fact={fact}
        draft={drafts[fact.id] ?? fact.value}
        busy={busyId === fact.id}
        onDraft={(value) => setDrafts((d) => ({ ...d, [fact.id]: value }))}
        onSave={() => void saveFact(fact.id)}
        onForget={() => void forgetFact(fact.id)}
        onConfirm={() => void confirmFact(fact.id)}
      />
    );
  }

  const { user } = useSession();
  const initial = (user?.name || user?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <Layout>
      <div className="space-y-8">
        <div className="flex items-center gap-4">
          <span
            aria-hidden
            className="inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xl font-semibold text-white shadow-sm"
          >
            {initial}
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Profile</h1>
            <p className="text-sm text-zinc-500">
              Facts the agent may use, and MCP API keys.
            </p>
            {user ? (
              <p className="mt-0.5 truncate text-xs text-zinc-400">
                {user.name ? `${user.name} · ` : ''}
                {user.email}
              </p>
            ) : null}
          </div>
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {loading ? (
          <Spinner label="Loading profile" />
        ) : (
          <>
            <section className="space-y-3">
              <div>
                <h2 className={SECTION_LABEL}>Facts</h2>
              </div>
              {active.length === 0 && needsConfirmation.length === 0 ? (
                <div className={`${CARD} px-5 py-10 text-center`}>
                  <p className="text-sm text-zinc-500">
                    No facts yet. Facts you share with Bellhop will show up here.
                  </p>
                </div>
              ) : (
                <div className="space-y-5">
                  {active.length > 0 ? (
                    <section aria-label="Active" className="space-y-2">
                      <h3 className="text-sm font-medium text-zinc-800">Active</h3>
                      <ul className={`${CARD} divide-y divide-zinc-100`}>{active.map(renderFact)}</ul>
                    </section>
                  ) : null}
                  {needsConfirmation.length > 0 ? (
                    <section aria-label="Needs confirmation" className="space-y-2">
                      <h3 className="text-sm font-medium text-zinc-800">Needs confirmation</h3>
                      <ul className={`${CARD} divide-y divide-zinc-100`}>
                        {needsConfirmation.map(renderFact)}
                      </ul>
                    </section>
                  ) : null}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <h2 className={SECTION_LABEL}>API keys</h2>
              <div className={`${CARD} space-y-5 p-4 sm:p-5`}>
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={(e) => void onCreateKey(e)}
                >
                  <label className="block flex-1 text-xs font-medium text-zinc-600">
                    Name
                    <input
                      className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 mt-1.5 block w-full"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      placeholder="e.g. Claude Desktop"
                    />
                  </label>
                  <Button type="submit" disabled={busyId === 'new-key'}>
                    Create key
                  </Button>
                </form>

                {plaintextKey && snippet ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-sm text-amber-950">
                    <p className="font-medium">Copy this key now — it is only shown once.</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <code className="min-w-0 break-all rounded-lg bg-white px-2 py-1 font-mono text-xs text-zinc-900 ring-1 ring-inset ring-amber-200">
                        {plaintextKey}
                      </code>
                      <Button
                        variant="secondary"
                        className="!px-3 !py-1 !text-xs"
                        onClick={() => void copyText(plaintextKey)}
                      >
                        Copy
                      </Button>
                    </div>
                    <p className="mt-4 text-xs font-medium uppercase tracking-wide text-amber-900/70">
                      MCP config
                    </p>
                    <pre className="mt-1.5 overflow-x-auto rounded-xl bg-zinc-900 p-4 font-mono text-xs leading-relaxed text-zinc-100">
                      {snippet}
                    </pre>
                    <Button
                      variant="secondary"
                      className="mt-3 !px-3 !py-1 !text-xs"
                      onClick={() => void copyText(snippet)}
                    >
                      Copy config
                    </Button>
                  </div>
                ) : null}

                {keys.length > 0 ? (
                  <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80">
                    {keys.map((k) => (
                      <li key={k.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                        <span
                          aria-hidden
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500"
                        >
                          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="8" cy="15" r="4" />
                            <path d="m11 12 9-9M16 7l3 3" />
                          </svg>
                        </span>
                        <div className="min-w-0">
                          <div className="font-medium text-zinc-900">{k.name}</div>
                          <div className="break-all text-xs tabular-nums text-zinc-500">
                            {k.prefix ?? k.start ?? 'key'}… · created{' '}
                            {new Date(k.createdAt).toLocaleString()}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </section>
          </>
        )}
      </div>
    </Layout>
  );
}
