import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/index.js';
import { mockApi } from '../api/mock.js';
import type { ChatMessage } from '../api/types.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { Chat } from './Chat.js';

function renderChat(): void {
  render(
    <BrowserRouter>
      <SessionProvider>
        <Chat />
      </SessionProvider>
    </BrowserRouter>,
  );
}

describe('Chat', () => {
  it('shows Bellhop is working… while send is in flight, then the reply', async () => {
    const replyText = 'Scripted reply ready.';
    let resolveSend: ((message: ChatMessage) => void) | undefined;
    vi.spyOn(api, 'sendMessage').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    const listed: ChatMessage[] = [
      {
        id: 'm1',
        role: 'user',
        text: 'Need a plumber tomorrow morning.',
        createdAt: '2026-01-10T09:00:00.000Z',
      },
    ];
    vi.spyOn(api, 'listMessages').mockImplementation(async () => listed.map((m) => ({ ...m })));

    const user = userEvent.setup();
    renderChat();

    await waitFor(() => {
      expect(screen.getByText(/need a plumber tomorrow morning/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId('task-chip')).toHaveTextContent('COMPARING');

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'hello there');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByText(/bellhop is working/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/type a message/i)).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    expect(screen.getByText('hello there')).toBeInTheDocument();

    listed.push(
      {
        id: 'm-user',
        role: 'user',
        text: 'hello there',
        createdAt: '2026-11-07T00:00:00.000Z',
      },
      {
        id: 'm-reply',
        role: 'assistant',
        text: replyText,
        createdAt: '2026-11-07T00:00:01.000Z',
      },
    );

    await act(async () => {
      resolveSend?.({
        id: 'm-reply',
        role: 'assistant',
        text: replyText,
        createdAt: '2026-11-07T00:00:01.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.getByText(replyText)).toBeInTheDocument();
    });
    expect(screen.queryByText(/bellhop is working/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/type a message/i)).toBeEnabled();
  });

  it('shows an approval card and confirm sends that card hash', async () => {
    const approve = vi.spyOn(api, 'approve');
    const listBookings = vi.spyOn(api, 'listBookings');
    const user = userEvent.setup();
    renderChat();

    await waitFor(() => {
      expect(screen.queryByText(/loading messages/i)).not.toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'book the plumber');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('approval-card')).toHaveTextContent('PipeRight Co.');
    });
    expect(screen.getByTestId('approval-card')).toHaveTextContent('INR');
    expect(screen.getByText(/see approval card/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^trace$/i }));
    await waitFor(() => {
      expect(screen.getByText('propose_booking')).toBeInTheDocument();
    });
    const detailButtons = screen.getAllByRole('button', { name: /show detail/i });
    const firstDetail = detailButtons[0];
    expect(firstDetail).toBeDefined();
    await user.click(firstDetail as HTMLElement);
    expect(screen.getByRole('list', { name: /trace events/i })).toHaveTextContent(
      /provider_id|proposalId|est_tokens|"from"/,
    );
    await user.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(screen.getByRole('list', { name: /trace events/i })).toHaveTextContent(
      'No trace events yet.',
    );

    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      expect(screen.getByText(/booked and verified with the provider/i)).toBeInTheDocument();
    });
    expect(approve).toHaveBeenCalledWith(
      expect.stringMatching(/^prop-/),
      expect.stringContaining('prov-piperight'),
    );
    expect(listBookings).toHaveBeenCalled();
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument();
  });

  it('shows an error banner when the model is unavailable', async () => {
    const user = userEvent.setup();
    renderChat();

    await waitFor(() => {
      expect(screen.queryByText(/loading messages/i)).not.toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'the model is unavailable');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/unavailable/i);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/503/);
    expect(input).toHaveValue('the model is unavailable');
    expect(screen.queryByText(/bellhop is working/i)).not.toBeInTheDocument();
  });

  it('banners and reloads the proposal when the provider cancels', async () => {
    renderChat();

    await waitFor(() => {
      expect(screen.getByText('QuickFix Plumbing')).toBeInTheDocument();
    });

    await act(async () => {
      await mockApi.simulateProviderCancel('b1');
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          'Your booking was cancelled by the provider — we found a replacement',
        ),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('approval-card')).toHaveTextContent('Replacement Co.');
    });
  });
});
