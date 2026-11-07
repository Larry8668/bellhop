import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const base =
  'inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 disabled:cursor-not-allowed disabled:opacity-50';

const variantClass: Record<Variant, string> = {
  primary: `${base} bg-zinc-900 text-white shadow-sm hover:bg-zinc-800`,
  secondary: `${base} border border-zinc-200 bg-white text-zinc-800 shadow-sm hover:border-zinc-300 hover:bg-zinc-50`,
  danger: `${base} bg-rose-600 text-white shadow-sm hover:bg-rose-700`,
  ghost: `${base} text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900`,
};

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  children: ReactNode;
}): React.ReactElement {
  return (
    <button type={type} className={`${variantClass[variant]} ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
}
