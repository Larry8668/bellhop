/**
 * Smoke test against a real local Ollama install (plan §0 exit criteria:
 * "both smoke tests pass"). Not run by vitest — `npm test` must stay
 * offline (plan §16) — invoke manually with `npm run smoke:ollama`.
 *
 * Requires Ollama running locally with `config.MODEL` pulled.
 */
import { generateText, tool } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const ollamaProvider = createOllama({ baseURL: config.OLLAMA_BASE_URL });
  const model = ollamaProvider(config.MODEL, {
    think: false,
    keep_alive: '10m',
    reliableToolCalling: false,
    options: {
      num_ctx: config.NUM_CTX,
      temperature: 0,
    },
  });

  const result = await generateText({
    model,
    prompt:
      'Find a plumber for my kitchen tap in Indiranagar this week, mornings only, under 1500 rupees',
    tools: {
      // No `execute`: we want the raw tool call back, not a run result —
      // the harness (not the model) ever calls real tools (plan §2 invariant 1).
      search_providers: tool({
        description: 'Search for home-service providers matching the given criteria',
        inputSchema: z.object({
          service: z.string().describe('The type of service needed, e.g. "plumber"'),
          area: z.string().describe('The neighborhood or area to search in'),
          date_range: z.string().describe('The desired date/time window, e.g. "this week, mornings"'),
        }),
      }),
    },
  });

  console.log('--- tool calls ---');
  console.log(JSON.stringify(result.toolCalls, null, 2));
  console.log('--- usage ---');
  console.log(JSON.stringify(result.usage, null, 2));

  const calledSearchProviders = result.toolCalls.some(
    (call) => call.toolName === 'search_providers',
  );

  if (!calledSearchProviders) {
    console.error('FAIL: model did not call search_providers');
    process.exit(1);
  }

  console.log('PASS: model called search_providers');
}

main().catch((err) => {
  console.error('smoke-ollama failed:', err);
  process.exit(1);
});
