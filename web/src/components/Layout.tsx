import { Link, NavLink, useNavigate } from 'react-router';
import type { ReactNode } from 'react';
import { useSession } from '../auth/SessionProvider.js';

function navClass(isActive: boolean): string {
  return `whitespace-nowrap rounded-full px-2 py-1.5 text-[13px] font-medium transition-colors sm:px-3 sm:text-sm ${
    isActive ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-500 hover:text-zinc-900'
  }`;
}

export function BrandMark({ className = 'size-7' }: { className?: string }): React.ReactElement {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-lg bg-zinc-900 text-white shadow-sm ${className}`}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="size-[60%]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 17h16" />
        <path d="M6 17a6 6 0 0 1 12 0" />
        <path d="M12 8V6" />
        <path d="M10 6h4" />
      </svg>
    </span>
  );
}

/**
 * App shell. `fill` makes the main area a fixed-height flex column (chat), so the
 * page itself doesn't scroll and children manage their own overflow.
 */
export function Layout({ children, fill = false }: { children: ReactNode; fill?: boolean }): React.ReactElement {
  const { signOut } = useSession();
  const navigate = useNavigate();

  return (
    <div className={`app-canvas flex flex-col ${fill ? 'h-dvh overflow-hidden' : 'min-h-dvh'}`}>
      <header className="sticky top-0 z-20 border-b border-zinc-200/70 bg-white/75 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-3 sm:gap-3 sm:px-4">
          <Link to="/" className="flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-tight text-zinc-900">
            <BrandMark />
            <span className="hidden sm:inline">Bellhop</span>
          </Link>
          <nav className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-full bg-zinc-100/80 p-1">
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
          </nav>
          <button
            type="button"
            className="inline-flex shrink-0 whitespace-nowrap rounded-full px-2 py-1.5 sm:px-3 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            onClick={async () => {
              await signOut();
              navigate('/login', { replace: true });
            }}
          >
            <svg viewBox="0 0 24 24" className="size-4 sm:hidden" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="m16 17 5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
            <span className="sr-only sm:not-sr-only">Sign out</span>
          </button>
        </div>
      </header>
      {fill ? (
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      ) : (
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
      )}
    </div>
  );
}
