import { Navigate, Route, Routes } from 'react-router';
import { SessionProvider } from './auth/SessionProvider.js';
import { RequireAuth } from './components/RequireAuth.js';
import { Bookings } from './pages/Bookings.js';
import { Chat } from './pages/Chat.js';
import { Login } from './pages/Login.js';
import { Profile } from './pages/Profile.js';
import { Proposals } from './pages/Proposals.js';

export function App(): React.ReactElement {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Chat />
            </RequireAuth>
          }
        />
        <Route
          path="/profile"
          element={
            <RequireAuth>
              <Profile />
            </RequireAuth>
          }
        />
        <Route
          path="/bookings"
          element={
            <RequireAuth>
              <Bookings />
            </RequireAuth>
          }
        />
        <Route
          path="/proposals"
          element={
            <RequireAuth>
              <Proposals />
            </RequireAuth>
          }
        />
        <Route
          path="/proposals/:id"
          element={
            <RequireAuth>
              <Proposals />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}
