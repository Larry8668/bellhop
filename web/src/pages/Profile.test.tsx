import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { __setFactsForTests } from '../api/mock.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { Profile } from './Profile.js';

function renderProfile(): void {
  render(
    <BrowserRouter>
      <SessionProvider>
        <Profile />
      </SessionProvider>
    </BrowserRouter>,
  );
}

async function settle(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByText(/loading profile/i)).not.toBeInTheDocument();
  });
}

describe('Profile facts', () => {
  it('groups active and unconfirmed facts and saves an inline edit', async () => {
    const user = userEvent.setup();
    renderProfile();
    await settle();

    const active = screen.getByRole('region', { name: /^active$/i });
    const needs = screen.getByRole('region', { name: /needs confirmation/i });
    const area = within(active).getByRole('listitem', { name: 'service_area' });
    expect(area).toBeInTheDocument();
    expect(within(area).getByText('explicit')).toBeInTheDocument();
    expect(within(needs).getByRole('listitem', { name: 'budget_ceiling' })).toBeInTheDocument();
    expect(within(needs).getByText('inferred')).toBeInTheDocument();

    const row = within(active).getByRole('listitem', { name: 'service_area' });
    const input = within(row).getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Koramangala');
    await user.click(within(row).getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const updated = within(screen.getByRole('region', { name: /^active$/i })).getByRole(
        'listitem',
        { name: 'service_area' },
      );
      expect(within(updated).getByRole('textbox')).toHaveValue('Koramangala');
    });
  });

  it('forgets a fact so it leaves the active group', async () => {
    const user = userEvent.setup();
    renderProfile();
    await settle();

    const row = screen.getByRole('listitem', { name: 'pets' });
    await user.click(within(row).getByRole('button', { name: /^forget$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('listitem', { name: 'pets' })).not.toBeInTheDocument();
    });
  });

  it('confirms an unconfirmed fact into the active group', async () => {
    const user = userEvent.setup();
    renderProfile();
    await settle();

    const needs = screen.getByRole('region', { name: /needs confirmation/i });
    await user.click(within(needs).getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      expect(
        within(screen.getByRole('region', { name: /^active$/i })).getByRole('listitem', {
          name: 'budget_ceiling',
        }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole('region', { name: /needs confirmation/i })).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no visible facts', async () => {
    __setFactsForTests([]);
    renderProfile();
    await settle();
    expect(screen.getByText(/no facts yet/i)).toBeInTheDocument();
  });
});
