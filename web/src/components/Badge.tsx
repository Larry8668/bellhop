import type { HTMLAttributes, ReactNode } from 'react';

const toneClass: Record<string, string> = {
  default: 'bg-zinc-100 text-zinc-700 ring-zinc-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  danger: 'bg-rose-50 text-rose-700 ring-rose-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
  accent: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
};

export function Badge({
  tone = 'default',
  children,
  className = '',
  ...rest
}: {
  tone?: keyof typeof toneClass;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>): React.ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${toneClass[tone] ?? toneClass.default} ${className}`.trim()}
      {...rest}
    >
      {children}
    </span>
  );
}
