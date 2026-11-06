import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { api } from '../api/index.js';
import { ApiError } from '../api/client.js';
import { useSession } from '../auth/SessionProvider.js';
import { Button } from '../components/Button.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import { log } from '../logger.js';

export function Login(): React.ReactElement {
  const { user, loading, signIn } = useSession();
  const location = useLocation();
  const from =
    (location.state as { from?: { pathname?: string } } | undefined)?.from
      ?.pathname ?? '/';

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && user) {
    return <Navigate to={from} replace />;
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
      } else {
        await api.signUp(email, password, name);
        await signIn(email, password);
      }
    } catch (err) {
      log.error({ err }, 'auth failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not complete request';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center bg-zinc-50 px-4 py-10">
      <div className="mx-auto w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-zinc-900">
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </h1>
        <p className="mt-1 text-sm text-zinc-600">
          Bellhop never books without your approval.
        </p>

        {error ? (
          <div className="mt-4">
            <ErrorBanner>{error}</ErrorBanner>
          </div>
        ) : null}

        <form className="mt-4 space-y-3" onSubmit={(e) => void onSubmit(e)}>
          {mode === 'signup' ? (
            <label className="block text-sm font-medium text-zinc-700">
              Name
              <input
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                value={name}
                onChange={(ev) => setName(ev.target.value)}
                autoComplete="name"
                required
              />
            </label>
          ) : null}
          <label className="block text-sm font-medium text-zinc-700">
            Email
            <input
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              type="email"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label className="block text-sm font-medium text-zinc-700">
            Password
            <input
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              type="password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              autoComplete={
                mode === 'signin' ? 'current-password' : 'new-password'
              }
              required
            />
          </label>

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || loading}
          >
            {submitting ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-zinc-600">
          {mode === 'signin' ? (
            <>
              No account?{' '}
              <button
                type="button"
                className="font-medium text-zinc-900 underline"
                onClick={() => {
                  setMode('signup');
                  setError(null);
                }}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                className="font-medium text-zinc-900 underline"
                onClick={() => {
                  setMode('signin');
                  setError(null);
                }}
              >
                Sign in
              </button>
            </>
          )}
        </p>

        <p className="mt-6 text-center text-xs text-zinc-500">
          <Link className="underline" to="/">
            Back to app
          </Link>
        </p>

        {loading ? (
          <div className="mt-4 flex justify-center">
            <Spinner label="Loading" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
