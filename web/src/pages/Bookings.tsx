import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/index.js';
import type { Booking } from '../api/types.js';
import { ApiError } from '../api/client.js';
import { Layout } from '../components/Layout.js';
import { Badge } from '../components/Badge.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import { log } from '../logger.js';

function statusTone(
  s: Booking['status'],
): 'success' | 'danger' | 'warning' {
  if (s === 'confirmed') return 'success';
  if (s === 'cancelled') return 'danger';
  return 'warning';
}

export function Bookings(): React.ReactElement {
  const [items, setItems] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listBookings();
      setItems(list);
    } catch (err) {
      log.error({ err }, 'list bookings failed');
      const message =
        err instanceof ApiError ? err.message : 'Could not load bookings';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { upcoming, past } = useMemo(() => {
    const u: Booking[] = [];
    const p: Booking[] = [];
    for (const b of items) {
      if (b.when === 'upcoming') u.push(b);
      else p.push(b);
    }
    return { upcoming: u, past: p };
  }, [items]);

  function row(b: Booking): React.ReactElement {
    return (
      <li
        key={b.id}
        className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <div className="font-medium text-zinc-900">{b.service}</div>
          <div className="text-xs text-zinc-600">{b.providerName}</div>
          <div className="mt-1 text-xs text-zinc-500">
            {new Date(b.slot.start).toLocaleString()} →{' '}
            {new Date(b.slot.end).toLocaleString()}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{b.price} INR</Badge>
          <Badge tone={statusTone(b.status)}>{b.status}</Badge>
        </div>
      </li>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Bookings</h1>
          <p className="text-sm text-zinc-600">Past and upcoming visits.</p>
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {loading ? (
          <Spinner label="Loading bookings" />
        ) : (
          <>
            <section>
              <h2 className="text-sm font-semibold text-zinc-900">Upcoming</h2>
              {upcoming.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">No upcoming bookings.</p>
              ) : (
                <ul className="mt-2 space-y-2">{upcoming.map(row)}</ul>
              )}
            </section>
            <section>
              <h2 className="text-sm font-semibold text-zinc-900">Past</h2>
              {past.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">No past bookings.</p>
              ) : (
                <ul className="mt-2 space-y-2">{past.map(row)}</ul>
              )}
            </section>
          </>
        )}
      </div>
    </Layout>
  );
}
