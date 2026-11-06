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
});

export type Config = z.infer<typeof configSchema>;

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

  return result.data;
}
