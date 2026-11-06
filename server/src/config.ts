import { z } from 'zod';

/**
 * Numeric env vars arrive as strings. `z.coerce.number()` converts them but
 * reports generic "invalid input" errors; we want the message to name the
 * offending key, so each numeric field is wrapped with a custom error map.
 */
function numberEnv(key: string) {
  return z.coerce.number({
    error: () => `Invalid config value for ${key}: expected a number`,
  });
}

/** Absent means "use the NODE_ENV default" (`true` outside production). */
function boolEnv(key: string) {
  return z
    .enum(['true', 'false', '1', '0'], {
      error: () => `Invalid config value for ${key}: expected true or false`,
    })
    .optional()
    .transform((value): boolean | undefined => {
      if (value === undefined) return undefined;
      return value === 'true' || value === '1';
    });
}

const configSchema = z.object({
  MODEL: z.string().default('qwen3.5:9b'),
  MODEL_FALLBACK: z.string().default('qwen3:8b'),
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  NUM_CTX: numberEnv('NUM_CTX').default(8192),
  LIMIT_MODEL_CALLS_PER_TURN: numberEnv('LIMIT_MODEL_CALLS_PER_TURN').default(8),
  LIMIT_TOOL_CALLS_PER_TURN: numberEnv('LIMIT_TOOL_CALLS_PER_TURN').default(15),
  LIMIT_TURN_WALL_CLOCK_MS: numberEnv('LIMIT_TURN_WALL_CLOCK_MS').default(60000),
  LIMIT_STATUS_CHECKS: numberEnv('LIMIT_STATUS_CHECKS').default(3),
  LIMIT_RETRIES_PER_TOOL: numberEnv('LIMIT_RETRIES_PER_TOOL').default(2),
  CONTEXT_BUDGET_TOKENS: numberEnv('CONTEXT_BUDGET_TOKENS').default(8192),
  PROVIDER_URL: z.string().default('http://localhost:4010'),
  PROVIDER_TIMEOUT_MS: numberEnv('PROVIDER_TIMEOUT_MS').default(5000),
  DB_PATH: z.string().default('./data/bellhop.db'),
  TRACES_DIR: z.string().default('../traces'),
  LOG_LEVEL: z.string().default('info'),
  SERVER_PORT: numberEnv('SERVER_PORT').default(4000),
  BETTER_AUTH_SECRET: z.string().default('dev-secret-change-me'),
  BETTER_AUTH_URL: z.string().default('http://localhost:4000'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  /** Off in production unless set. Gates `POST /api/dev/provider-cancel/:bookingId` (plan §12). */
  DEV_ROUTES: boolEnv('DEV_ROUTES'),
  PROACTIVE_POLL_MS: numberEnv('PROACTIVE_POLL_MS').int().positive().default(15000),
});

export type Config = Omit<z.infer<typeof configSchema>, 'DEV_ROUTES'> & {
  DEV_ROUTES: boolean;
};

/**
 * Loads and validates process env into a typed Config. Throws an Error whose
 * message names the offending key when a value is invalid (plan §1, §9).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(configSchema.shape)) {
    const value = env[key];
    if (value !== undefined) input[key] = value;
  }

  const result = configSchema.safeParse(input);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || 'config';
      return issue.message.includes(key) ? issue.message : `Invalid config value for ${key}: ${issue.message}`;
    });
    throw new Error(`Invalid configuration: ${messages.join('; ')}`);
  }

  return {
    ...result.data,
    DEV_ROUTES: result.data.DEV_ROUTES ?? env.NODE_ENV !== 'production',
  };
}
