import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/index.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { Bookings } from './Bookings.js';

function renderBookings(): void {
  render(
    <BrowserRouter>
      <SessionProvider>
        <Bookings />
      </SessionProvider>
    </BrowserRouter>,
  );
}

describe('Bookings dev cancel', () => {
  it('confirms inline, calls the dev endpoint, and refreshes status', async () => {
    const spy = vi.spyOn(api, 'simulateProviderCancel');
    const user = userEvent.setup();
    renderBookings();

    await waitFor(() => {
      expect(screen.getByText(/switch replacement/i)).toBeInTheDocument();
    });

    const upcoming = screen.getByRole('region', { name: /^upcoming$/i });
    const past = screen.getByRole('region', { name: /^past$/i });
    expect(
      within(past).queryByRole('button', { name: /simulate provider cancel/i }),
    ).not.toBeInTheDocument();
    expect(within(upcoming).getByText('confirmed')).toBeInTheDocument();

    await user.click(
      within(upcoming).getByRole('button', { name: /simulate provider cancel/i }),
    );
    expect(spy).not.toHaveBeenCalled();

    await user.click(within(upcoming).getByRole('button', { name: /yes, simulate cancel/i }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('b1');
    });
    await waitFor(() => {
      expect(within(upcoming).getByText('cancelled')).toBeInTheDocument();
    });
    expect(
      within(upcoming).queryByRole('button', { name: /simulate provider cancel/i }),
    ).not.toBeInTheDocument();
  });
});
