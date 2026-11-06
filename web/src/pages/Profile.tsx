import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api/index.js';
import type { ApiKey, CreateApiKeyResult, Fact } from '../api/types.js';
import { ApiError } from '../api/client.js';
import { Layout } from '../components/Layout.js';
import { Button } from '../components/Button.js';
import { Badge } from '../components/Badge.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import { log } from '../logger.js';

export function Profile(): React.ReactElement {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
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
    } catch (err) {
      log.error({ err }, 'profile load failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not load profile data';
      setError(message);
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
      const message =
        err instanceof ApiError ? err.message : 'Could not update fact';
      setError(message);
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
      const message =
        err instanceof ApiError ? err.message : 'Could not forget fact';
      setError(message);
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
      const message =
        err instanceof ApiError ? err.message : 'Could not confirm fact';
      setError(message);
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
      const message =
        err instanceof ApiError ? err.message : 'Could not create API key';
      setError(message);
    } finally {
      setBusyId(null);
    }
  }

  async function copyKey(): Promise<void> {
    if (!plaintextKey) return;
    try {
      await navigator.clipboard.writeText(plaintextKey);
    } catch (err) {
      log.error({ err }, 'clipboard write failed');
      setError('Could not copy to clipboard');
    }
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
              <div className="mt-2 overflow-x-auto rounded-xl border border-zinc-200 bg-white">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="border-b border-zinc-100 bg-zinc-50 text-xs uppercase text-zinc-500">
                    <tr>
                      <th className="px-3 py-2">Key</th>
                      <th className="px-3 py-2">Kind</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Value</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {facts.map((f) => (
                      <tr key={f.id} className="border-b border-zinc-50 last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{f.key}</td>
                        <td className="px-3 py-2">
                          <Badge tone={f.kind === 'explicit' ? 'info' : 'warning'}>
                            {f.kind}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            tone={
                              f.status === 'active'
                                ? 'success'
                                : f.status === 'unconfirmed'
                                  ? 'warning'
                                  : 'danger'
                            }
                          >
                            {f.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            className="w-full max-w-xs rounded border border-zinc-200 px-2 py-1 text-xs"
                            value={drafts[f.id] ?? f.value}
                            onChange={(e) =>
                              setDrafts((d) => ({ ...d, [f.id]: e.target.value }))
                            }
                            disabled={f.status === 'forgotten'}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <Button
                              variant="secondary"
                              className="!px-2 !py-1 !text-xs"
                              disabled={busyId === f.id || f.status === 'forgotten'}
                              onClick={() => void saveFact(f.id)}
                            >
                              Save
                            </Button>
                            <Button
                              variant="ghost"
                              className="!px-2 !py-1 !text-xs"
                              disabled={busyId === f.id || f.status === 'forgotten'}
                              onClick={() => void forgetFact(f.id)}
                            >
                              Forget
                            </Button>
                            {f.status === 'unconfirmed' ? (
                              <Button
                                variant="primary"
                                className="!px-2 !py-1 !text-xs"
                                disabled={busyId === f.id}
                                onClick={() => void confirmFact(f.id)}
                              >
                                Confirm
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                    className="mt-1 block rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="e.g. Claude Desktop"
                  />
                </label>
                <Button type="submit" disabled={busyId === 'new-key'}>
                  Create key
                </Button>
              </form>

              {plaintextKey ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  <p className="font-medium">Copy this key now — it is only shown once.</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="break-all rounded bg-white px-2 py-1 text-xs text-zinc-900">
                      {plaintextKey}
                    </code>
                    <Button variant="secondary" className="!text-xs" onClick={() => void copyKey()}>
                      Copy
                    </Button>
                  </div>
                </div>
              ) : null}

              <ul className="mt-4 space-y-2">
                {keys.map((k) => (
                  <li
                    key={k.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
                  >
                    <div>
                      <div className="font-medium text-zinc-900">{k.name}</div>
                      <div className="text-xs text-zinc-500">
                        {k.prefix}… · created {new Date(k.createdAt).toLocaleString()}
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
