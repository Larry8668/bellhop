import type { TaskState } from '../api/types.js';
import { Badge } from './Badge.js';

function asText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') {
    if (value.includes('T')) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
    }
    return value;
  }
  return null;
}

/** Task-state summary from `GET /api/task`: state plus whatever constraints are set. */
export function TaskChip({ task }: { task: TaskState | null }): React.ReactElement {
  if (!task) {
    return (
      <p className="mt-2 text-xs text-zinc-400" data-testid="task-chip">
        No active task
      </p>
    );
  }

  const service = asText(task.service);
  const area = asText(task.area);
  const from = asText(task.window_from);
  const to = asText(task.window_to);
  const budget = asText(task.budget);
  const windowLabel = from || to ? [from ?? '…', to ?? '…'].join(' – ') : null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="task-chip">
      <Badge tone="info">
        <span className="size-1.5 rounded-full bg-sky-500" aria-hidden />
        {task.state}
      </Badge>
      {service ? <Badge>{service}</Badge> : null}
      {area ? <Badge>{area}</Badge> : null}
      {windowLabel ? <Badge>{windowLabel}</Badge> : null}
      {budget ? <Badge>{`budget ${budget}`}</Badge> : null}
    </div>
  );
}
