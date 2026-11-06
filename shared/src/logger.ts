import pino from 'pino';
import type { Logger } from 'pino';

const REDACT_PATHS = [
  '*.password',
  '*.token',
  '*.secret',
  '*.authorization',
  'req.headers.authorization',
] as const;

function resolveLevel(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  return process.env.LOG_LEVEL ?? 'info';
}

export type { Logger };

export function createLogger(opts: { name: string; level?: string }): Logger {
  const level = resolveLevel(opts.level);
  const baseOptions: pino.LoggerOptions = {
    name: opts.name,
    level,
    redact: {
      paths: [...REDACT_PATHS],
      remove: true,
    },
  };

  const usePretty =
    process.env.NODE_ENV !== 'production' && process.stdout.isTTY === true;

  if (usePretty) {
    const transport = pino.transport({
      target: 'pino-pretty',
      options: { colorize: true },
    });
    return pino(baseOptions, transport);
  }

  return pino(baseOptions);
}

export function childLogger(
  parent: Logger,
  module: string,
  bindings?: Record<string, unknown>,
): Logger {
  return parent.child({ module, ...bindings });
}
