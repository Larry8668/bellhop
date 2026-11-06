import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api/index.js';
import type { ApiKey, CreateApiKeyResult, Fact } from '../api/types.js';
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
  return (
    <li
      aria-label={fact.key}
      className="rounded-xl border border-zinc-200 bg-white p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs text-zinc-800">{fact.key}</span>
        <Badge tone={fact.kind === 'explicit' ? 'info' : 'warning'}>{fact.kind}</Badge>
      </div>
      <label className="mt-2 block text-xs text-zinc-500">
        Value
        <input
          className="mt-1 w-full rounded border border-zinc-200 px-2 py-1 text-sm text-zinc-900"
          value={draft}
          aria-label={`Value for ${fact.key}`}
          onChange={(e) => onDraft(e.target.value)}
          disabled={busy}
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          variant="secondary"
          className="!px-2 !py-1 !text-xs"
          disabled={busy}
          onClick={onSave}
        >
          Save
        </Button>
        <Button
          variant="ghost"
          className="!px-2 !py-1 !text-xs"
          disabled={busy}
          onClick={onForget}
        >
          Forget
        </Button>
        {fact.status === 'unconfirmed' ? (
          <Button
            variant="primary"
            className="!px-2 !py-1 !text-xs"
            disabled={busy}
            onClick={onConfirm}
          >
            Confirm
          </Button>
        ) : null}
      </div>
    </li>
  );
}

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

  return (
    <Layout>
      <div className="space-y-8">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Profile</h1>
          <p className="text-sm text-zinc-600">Facts the agent may use, and MCP API keys.</p>
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {loading ? (
          <Spinner label="Loading profile" />
        ) : (
          <>
            <section>
              <h2 className="text-sm font-semibold text-zinc-900">Facts</h2>
              {active.length === 0 && needsConfirmation.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">
                  No facts yet. Facts you share with Bellhop will show up here.
                </p>
              ) : (
                <div className="mt-3 space-y-6">
                  {active.length > 0 ? (
                    <section aria-label="Active" className="space-y-2">
                      <h3 className="text-sm font-medium text-zinc-800">Active</h3>
                      <ul className="space-y-2">{active.map(renderFact)}</ul>
                    </section>
                  ) : null}
                  {needsConfirmation.length > 0 ? (
                    <section aria-label="Needs confirmation" className="space-y-2">
                      <h3 className="text-sm font-medium text-zinc-800">Needs confirmation</h3>
                      <ul className="space-y-2">{needsConfirmation.map(renderFact)}</ul>
                    </section>
                  ) : null}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-sm font-semibold text-zinc-900">API keys</h2>
              <form
                className="mt-2 flex flex-wrap items-end gap-2"
                onSubmit={(e) => void onCreateKey(e)}
              >
                <label className="block text-sm text-zinc-700">
                  Name
                  <input
                    className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm sm:w-auto"
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
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  <p className="font-medium">Copy this key now — it is only shown once.</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="break-all rounded bg-white px-2 py-1 text-xs text-zinc-900">
                      {plaintextKey}
                    </code>
                    <Button
                      variant="secondary"
                      className="!text-xs"
                      onClick={() => void copyText(plaintextKey)}
                    >
                      Copy
                    </Button>
                  </div>
                  <p className="mt-3 text-xs font-medium text-amber-950">MCP config</p>
                  <pre className="mt-1 overflow-x-auto rounded bg-white p-2 text-xs text-zinc-900">
                    {snippet}
                  </pre>
                  <Button
                    variant="secondary"
                    className="mt-2 !text-xs"
                    onClick={() => void copyText(snippet)}
                  >
                    Copy config
                  </Button>
                </div>
              ) : null}

              <ul className="mt-4 space-y-2">
                {keys.map((k) => (
                  <li
                    key={k.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-zinc-900">{k.name}</div>
                      <div className="text-xs break-all text-zinc-500">
                        {k.prefix ?? k.start ?? 'key'}… · created{' '}
                        {new Date(k.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </Layout>
  );
}
