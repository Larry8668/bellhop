import type { ReactNode } from 'react';

export function ErrorBanner({
  title = 'Something went wrong',
  children,
}: {
  title?: string;
  children: ReactNode;
}): React.ReactElement {
  return (
    <div
      className="flex gap-3 rounded-2xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-sm text-rose-900"
      role="alert"
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-rose-500 text-[11px] font-bold text-white" aria-hidden>
        !
      </span>
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <div className="mt-0.5 text-rose-800">{children}</div>
      </div>
    </div>
  );
}
