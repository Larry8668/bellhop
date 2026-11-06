import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SessionProvider } from '../auth/SessionProvider.js';
import { Chat } from './Chat.js';

describe('Chat', () => {
  it('with mockApi: sending "book the plumber" shows approval; Confirm removes it', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <SessionProvider>
          <Chat />
        </SessionProvider>
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByText(/loading messages/i)).not.toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/type a message/i);
    await user.type(input, 'book the plumber');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(screen.getByText('PipeRight Co.')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      expect(screen.queryByText('PipeRight Co.')).not.toBeInTheDocument();
    });
  });
});
