import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Proposal } from '../api/types.js';
import { ApprovalCard } from './ApprovalCard.js';

const proposal: Proposal = {
  id: 'p1',
  action: 'book',
  providerName: 'Test Plumbing',
  service: 'Leak fix',
  slot: {
    start: new Date(Date.UTC(2026, 1, 1, 10, 0, 0)).toISOString(),
    end: new Date(Date.UTC(2026, 1, 1, 12, 0, 0)).toISOString(),
  },
  price: 1500,
  currency: 'INR',
  expiresAt: new Date(Date.UTC(2026, 1, 2, 0, 0, 0)).toISOString(),
};

describe('ApprovalCard', () => {
  it('renders the details and calls onConfirm / onDecline', async () => {
    const onConfirm = vi.fn();
    const onDecline = vi.fn();
    const user = userEvent.setup();

    render(
      <ApprovalCard
        proposal={proposal}
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
});
