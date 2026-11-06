import { z } from 'zod';

const truthyEnv = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v === '') return false;
    const n = v.trim().toLowerCase();
    return n === '1' || n === 'true';
  });

const envSchema = z.object({
  PORT: z.coerce.number().default(4010),
  SEED: z.coerce.number().default(42),
  PROVIDER_ADMIN: truthyEnv,
  LOG_LEVEL: z.string().default('info'),
  DB_PATH: z.string().default('./data/provider.db'),
  /** How long a simulated `book` timeout waits before replying 504 (plan §4). */
  TIMEOUT_DELAY_MS: z.coerce.number().int().default(8000),
  /** Probability a hold's quoted price drifts from the search price (plan §4). */
  HOLD_PRICE_DRIFT_PROB: z.coerce.number().min(0).max(1).default(0.15),
});

export type ProviderConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const raw = {
    PORT: env.PORT,
    SEED: env.SEED,
    PROVIDER_ADMIN: env.PROVIDER_ADMIN,
    LOG_LEVEL: env.LOG_LEVEL,
    DB_PATH: env.DB_PATH,
    TIMEOUT_DELAY_MS: env.TIMEOUT_DELAY_MS,
    HOLD_PRICE_DRIFT_PROB: env.HOLD_PRICE_DRIFT_PROB,
  };

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const segment = issue?.path[0];
    const key = segment !== undefined ? String(segment) : 'environment';
    throw new Error(`Invalid config: ${key}`);
  }

  return parsed.data;
}
