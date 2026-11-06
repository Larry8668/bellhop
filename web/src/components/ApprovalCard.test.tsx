import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProposalDetail } from '../api/types.js';
import { ApprovalCard } from './ApprovalCard.js';

const baseProposal: ProposalDetail = {
  id: 'p1',
  user_id: 'u1',
  action: 'book',
  provider_id: 'prov1',
  provider_name: 'Test Plumbing',
  service: 'Leak fix',
  slot: {
    start: new Date(Date.UTC(2026, 1, 1, 10, 0, 0)).toISOString(),
    end: new Date(Date.UTC(2026, 1, 1, 12, 0, 0)).toISOString(),
  },
  price: 1500,
  currency: 'INR',
  booking_id: null,
  hold_id: 'h1',
  hold_expires_at: new Date(Date.UTC(2026, 1, 2, 0, 0, 0)).toISOString(),
  hash: 'test-hash',
  status: 'pending',
  created_at: new Date(Date.UTC(2026, 1, 1, 8, 0, 0)).toISOString(),
  updated_at: new Date(Date.UTC(2026, 1, 1, 8, 0, 0)).toISOString(),
  expired: false,
};

describe('ApprovalCard', () => {
  it('renders the details and calls onConfirm / onDecline', async () => {
    const onConfirm = vi.fn();
    const onDecline = vi.fn();
    const user = userEvent.setup();

    render(
      <ApprovalCard
        proposal={baseProposal}
        onConfirm={onConfirm}
        onDecline={onDecline}
      />,
    );

    expect(screen.getByText('Test Plumbing')).toBeInTheDocument();
    expect(screen.getByText('Leak fix')).toBeInTheDocument();
    expect(screen.getByText(/1500/)).toBeInTheDocument();
    expect(screen.getByText(/INR/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^confirm$/i }));
    await user.click(screen.getByRole('button', { name: /^decline$/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('shows an expired badge when expired', () => {
    const { container } = render(
      <ApprovalCard
        proposal={{ ...baseProposal, expired: true }}
        onConfirm={vi.fn()}
        onDecline={vi.fn()}
      />,
    );

    const card = within(container.firstElementChild as HTMLElement);
    expect(card.getByTitle('Expired')).toBeInTheDocument();
    expect(card.getByRole('button', { name: /^confirm$/i })).toBeDisabled();
  });
});
