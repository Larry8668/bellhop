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
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
      role="alert"
    >
      <p className="font-medium">{title}</p>
      <div className="mt-1 text-red-800">{children}</div>
    </div>
  );
}
