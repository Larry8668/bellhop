import { createLogger, type Logger } from '@bellhop/shared/logger';

/** Module logger. Tests run under Vitest, which sets `VITEST`, and stay quiet. */
export function moduleLogger(name: string): Logger {
  if (process.env.VITEST) return createLogger({ name, level: 'silent' });
  return createLogger({ name });
}
