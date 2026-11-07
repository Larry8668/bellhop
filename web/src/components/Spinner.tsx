export function Spinner({ label = 'Loading' }: { label?: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2.5 text-sm text-zinc-500" role="status" aria-live="polite">
      <span className="grid grid-cols-3 gap-[3px]" aria-hidden>
        {Array.from({ length: 9 }, (_, i) => (
          <span
            key={i}
            className="size-[5px] animate-pulse rounded-[1px] bg-zinc-800"
            style={{ animationDelay: `${(i % 3) * 120 + Math.floor(i / 3) * 120}ms` }}
          />
        ))}
      </span>
      <span className="shimmer-text font-medium">{label}</span>
    </div>
  );
}
