import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/index.js';
import type { Booking } from '../api/types.js';
import { Layout } from '../components/Layout.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';
import { log } from '../logger.js';
import { errorMessage } from '../uiError.js';

function statusTone(
  s: Booking['status'],
): 'success' | 'danger' | 'warning' {
  if (s === 'confirmed') return 'success';
  if (s === 'cancelled') return 'danger';
  return 'warning';
}

export function Bookings(): React.ReactElement {
  const navigate = useNavigate();
  const [items, setItems] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [simulateBusyId, setSimulateBusyId] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (!hasLoaded.current) setLoading(true);
    setError(null);
    try {
      const list = await api.listBookings();
      setItems(list);
      hasLoaded.current = true;
    } catch (err) {
      log.error({ err }, 'list bookings failed');
      setError(errorMessage(err, 'Could not load bookings'));
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

  async function handleCancelBooking(bookingId: string): Promise<void> {
    setError(null);
    setCancelBusyId(bookingId);
    try {
      await api.createProposal({ action: 'cancel', booking_id: bookingId });
      navigate('/proposals');
    } catch (err) {
      log.error({ err }, 'create cancel proposal failed');
      setError(errorMessage(err, 'Could not request cancellation'));
    } finally {
      setCancelBusyId(null);
    }
  }

  async function handleSimulateCancel(bookingId: string): Promise<void> {
    setError(null);
    setSimulateBusyId(bookingId);
    try {
      await api.simulateProviderCancel(bookingId);
      setArmedId(null);
      await load();
    } catch (err) {
      log.error({ err, bookingId }, 'simulate provider cancel failed');
      setError(errorMessage(err, 'Could not simulate provider cancel'));
    } finally {
      setSimulateBusyId(null);
    }
  }

  function row(b: Booking): React.ReactElement {
    const canRequestCancel = b.when === 'upcoming' && b.status === 'confirmed';
    const armed = armedId === b.id;
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
          {canRequestCancel ? (
            <>
              <Button
                variant="secondary"
                className="text-xs"
                disabled={cancelBusyId === b.id}
                onClick={() => void handleCancelBooking(b.id)}
              >
                Cancel booking
              </Button>
              {armed ? (
                <>
                  <Button
                    variant="danger"
                    className="text-xs"
                    disabled={simulateBusyId === b.id}
                    onClick={() => void handleSimulateCancel(b.id)}
                  >
                    Yes, simulate cancel
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-xs"
                    disabled={simulateBusyId === b.id}
                    onClick={() => setArmedId(null)}
                  >
                    Back
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  className="text-xs"
                  onClick={() => setArmedId(b.id)}
                >
                  Simulate provider cancel
                </Button>
              )}
            </>
          ) : null}
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
            <section aria-label="Upcoming">
              <h2 className="text-sm font-semibold text-zinc-900">Upcoming</h2>
              {upcoming.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">No upcoming bookings.</p>
              ) : (
                <ul className="mt-2 space-y-2">{upcoming.map(row)}</ul>
              )}
            </section>
            <section aria-label="Past">
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
