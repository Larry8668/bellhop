import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { mockApi } from '../api/mock.js';
import { __setMockUserForTests } from '../api/mock.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { Login } from './Login.js';

describe('Login', () => {
  it('renders and calls signIn with the typed values', async () => {
    __setMockUserForTests(null);
    const signIn = vi.spyOn(mockApi, 'signIn').mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <SessionProvider>
          <Login />
        </SessionProvider>
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/email/i), 'pat@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith('pat@example.com', 'hunter2');
    });
  });
});
