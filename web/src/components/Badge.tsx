import type { ReactNode } from 'react';

const toneClass: Record<string, string> = {
  default: 'bg-zinc-100 text-zinc-800',
  success: 'bg-emerald-100 text-emerald-900',
  warning: 'bg-amber-100 text-amber-900',
  danger: 'bg-red-100 text-red-900',
  info: 'bg-sky-100 text-sky-900',
};

export function Badge({
  tone = 'default',
  children,
}: {
  tone?: keyof typeof toneClass;
  children: ReactNode;
}): React.ReactElement {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${toneClass[tone] ?? toneClass.default}`}
    >
      {children}
    </span>
  );
}
