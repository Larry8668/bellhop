import { Link, NavLink, useNavigate } from 'react-router';
import type { ReactNode } from 'react';
import { useSession } from '../auth/SessionProvider.js';
import { Button } from './Button.js';

const linkBase =
  'whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium hover:bg-zinc-100';

function navClass(isActive: boolean): string {
  return `${linkBase} ${isActive ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-600'}`;
}

export function Layout({ children }: { children: ReactNode }): React.ReactElement {
  const { signOut } = useSession();
  const navigate = useNavigate();

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <Link to="/" className="text-lg font-semibold text-zinc-900">
            Bellhop
          </Link>
          <nav className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
            <NavLink to="/" end className={({ isActive }) => navClass(isActive)}>
              Chat
            </NavLink>
            <NavLink to="/proposals" className={({ isActive }) => navClass(isActive)}>
              Proposals
            </NavLink>
            <NavLink to="/bookings" className={({ isActive }) => navClass(isActive)}>
              Bookings
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => navClass(isActive)}>
              Profile
            </NavLink>
            <Button
              variant="ghost"
              className="ml-1 whitespace-nowrap"
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
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
