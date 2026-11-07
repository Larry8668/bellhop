import { createAnthropic } from '@ai-sdk/anthropic';
import { createOllama } from 'ai-sdk-ollama';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { Config } from '../config.js';

type ModelConfig = Pick<Config, 'MODEL' | 'OLLAMA_BASE_URL' | 'NUM_CTX'> &
  Partial<Pick<Config, 'MODEL_PROVIDER' | 'ANTHROPIC_MODEL'>>;

/**
 * Live model for a turn (plan §1). Default is local Ollama; `reliableToolCalling`
 * stays off so every model call is a real step the limit and the trace can see.
 * `MODEL_PROVIDER=anthropic` is a demo-only switch for lower latency (reads
 * ANTHROPIC_API_KEY from the environment). Offline evals pass a mock instead.
 */
export function createAgentModel(config: ModelConfig): LanguageModel {
  if (config.MODEL_PROVIDER === 'anthropic') return createAnthropicModel(config.ANTHROPIC_MODEL ?? 'claude-haiku-5-5');
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

function createAnthropicModel(modelId: string): LanguageModel {
  const anthropic = createAnthropic();
  return wrapLanguageModel({
    model: anthropic(modelId),
    middleware: {
      specificationVersion: 'v4',
      // Current Claude models reject non-default sampling params; the agent
      // sets temperature 0 for Ollama, so drop it here. Low effort keeps
      // per-step latency down; thinking is off because prepareStep rebuilds the
      // system prompt each step, which invalidates bound thinking blocks.
      transformParams: async ({ params }) => {
        const rest = { ...params };
        delete rest.temperature;
        return {
          ...rest,
          providerOptions: {
            ...rest.providerOptions,
            anthropic: { effort: 'low', thinking: { type: 'disabled' }, ...(rest.providerOptions?.anthropic ?? {}) },
          },
        };
      },
    },
  });
}
