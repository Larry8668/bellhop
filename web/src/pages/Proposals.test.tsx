import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/index.js';
import type { ProposalDetail } from '../api/types.js';
import { __setProposalsForTests } from '../api/mock.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { Proposals } from './Proposals.js';

function detail(overrides: Partial<ProposalDetail>): ProposalDetail {
  return {
    id: 'p-test',
    user_id: 'u-demo',
    action: 'book',
    provider_id: 'prov-x',
    provider_name: 'Mock Co',
    service: 'Leak repair',
    slot: {
      start: new Date(Date.UTC(2026, 2, 1, 10, 0, 0)).toISOString(),
      end: new Date(Date.UTC(2026, 2, 1, 12, 0, 0)).toISOString(),
    },
    price: 1000,
    currency: 'INR',
    booking_id: null,
    hold_id: 'hold-x',
    hold_expires_at: new Date(Date.UTC(2026, 2, 2, 12, 0, 0)).toISOString(),
    hash: 'hash-approve-me',
    status: 'pending',
    created_at: new Date(Date.UTC(2026, 2, 1, 9, 0, 0)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 2, 1, 9, 0, 0)).toISOString(),
    expired: false,
    ...overrides,
  };
}

describe('Proposals', () => {
  it('renders pending proposals and approve passes the proposal hash', async () => {
    const proposalId = 'p1';
    __setProposalsForTests([detail({ id: proposalId, hash: 'secret-hash' })]);
    const approve = vi.spyOn(api, 'approve').mockResolvedValue({
      outcome: { kind: 'booked', booking_id: 'bk1' },
      message: 'Done.',
    });

    const user = userEvent.setup();
    const { container } = render(
      <BrowserRouter>
        <SessionProvider>
          <Proposals />
        </SessionProvider>
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Mock Co')).toBeInTheDocument();
    });

    const row = container.querySelector(`#proposal-${proposalId}`);
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole('button', { name: /^confirm$/i }));

    expect(approve).toHaveBeenCalledWith('p1', 'secret-hash');
  });

  it('reloads the list when outcome is needs_reapproval', async () => {
    const p = detail({ id: 'p-re', hash: 'hash-needs-reapproval' });
    __setProposalsForTests([p]);
    const listProposals = vi.spyOn(api, 'listProposals');

    const user = userEvent.setup();
    const { container } = render(
      <BrowserRouter>
        <SessionProvider>
          <Proposals />
        </SessionProvider>
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Mock Co')).toBeInTheDocument();
    });

    const callsAfterLoad = listProposals.mock.calls.length;
    const row = container.querySelector('#proposal-p-re');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      expect(listProposals.mock.calls.length).toBeGreaterThan(callsAfterLoad);
    });
  });

  it('shows unconfirmed feedback as a warning, not success styling', async () => {
    __setProposalsForTests([detail({ id: 'p-u', hash: 'hash-unconfirmed' })]);

    const user = userEvent.setup();
    const { container } = render(
      <BrowserRouter>
        <SessionProvider>
          <Proposals />
        </SessionProvider>
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Mock Co')).toBeInTheDocument();
    });

    const row = container.querySelector('#proposal-p-u');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/unconfirmed/i);
    });
    expect(screen.getByRole('status').className).toMatch(/amber/);
  });
});
