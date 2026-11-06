import { Navigate, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { useSession } from '../auth/SessionProvider.js';
import { Spinner } from './Spinner.js';

export function RequireAuth({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-50">
        <Spinner label="Checking session" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
