export function Spinner({
  label = 'Loading',
}: {
  label?: string;
}): React.ReactElement {
  return (
    <div
      className="flex items-center gap-2 text-sm text-zinc-600"
      role="status"
      aria-live="polite"
    >
      <span
        className="inline-block size-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700"
        aria-hidden
      />
      <span>{label}</span>
    </div>
  );
}
