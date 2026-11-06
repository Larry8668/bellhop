import { Link, NavLink, useNavigate } from 'react-router';
import type { ReactNode } from 'react';
import { useSession } from '../auth/SessionProvider.js';
import { Button } from './Button.js';

const linkBase =
  'rounded-md px-3 py-2 text-sm font-medium hover:bg-zinc-100';

function navClass(isActive: boolean): string {
  return `${linkBase} ${isActive ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-600'}`;
}

export function Layout({ children }: { children: ReactNode }): React.ReactElement {
  const { signOut } = useSession();
  const navigate = useNavigate();

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link to="/" className="text-lg font-semibold text-zinc-900">
            Bellhop
          </Link>
          <nav className="flex flex-wrap items-center gap-1">
            <NavLink to="/" end className={({ isActive }) => navClass(isActive)}>
              Chat
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => navClass(isActive)}>
              Profile
            </NavLink>
            <NavLink to="/bookings" className={({ isActive }) => navClass(isActive)}>
              Bookings
            </NavLink>
            <Button
              variant="ghost"
              className="ml-1"
              onClick={async () => {
                await signOut();
                navigate('/login', { replace: true });
              }}
            >
              Sign out
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  );
}
