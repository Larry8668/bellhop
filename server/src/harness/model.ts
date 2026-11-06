import { createOllama } from 'ai-sdk-ollama';
import type { LanguageModel } from 'ai';
import type { Config } from '../config.js';

/**
 * Ollama model for a live turn (plan §1). `reliableToolCalling` stays off so
 * every model call is a real step the limit and the trace can see.
 * Offline evals pass a `MockLanguageModelV4` instead of calling this.
 */
export function createAgentModel(config: Pick<Config, 'MODEL' | 'OLLAMA_BASE_URL' | 'NUM_CTX'>): LanguageModel {
  const ollama = createOllama({ baseURL: config.OLLAMA_BASE_URL });
  return ollama(config.MODEL, {
    think: false,
    keep_alive: '10m',
    reliableToolCalling: false,
    options: {
      num_ctx: config.NUM_CTX,
      temperature: 0,
    },
  });
}
