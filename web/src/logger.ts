/**
 * Browser logger with the same `(fields, message)` call shape as the shared pino
 * logger, so UI code reads like server code. Debug output is dropped in production builds.
 */
type Fields = Record<string, unknown>;
type Level = 'debug' | 'info' | 'warn' | 'error';

export interface WebLogger {
  debug(fields: Fields, message: string): void;
  info(fields: Fields, message: string): void;
  warn(fields: Fields, message: string): void;
  error(fields: Fields, message: string): void;
}

const sink: Record<Level, (...args: unknown[]) => void> = {
  // eslint-disable-next-line no-console
  debug: console.debug,
  // eslint-disable-next-line no-console
  info: console.info,
  // eslint-disable-next-line no-console
  warn: console.warn,
  // eslint-disable-next-line no-console
  error: console.error,
};

export function createWebLogger(module: string): WebLogger {
  const emit = (level: Level) => (fields: Fields, message: string): void => {
    if (level === 'debug' && !import.meta.env.DEV) return;
    sink[level](`[${module}] ${message}`, fields);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const log = createWebLogger('web');
