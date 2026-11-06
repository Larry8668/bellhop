import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';

/**
 * Shared fake usage for scripted-model steps (plan §9, §16). Evals run
 * offline against `MockLanguageModelV4`, never Ollama, so token counts are
 * fixed stand-ins rather than anything measured.
 */
export const mockUsage: LanguageModelV4GenerateResult['usage'] = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/**
 * One `doGenerate` step where the model answers with plain text and stops.
 */
export function textStep(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: mockUsage,
    warnings: [],
  };
}

/**
 * One `doGenerate` step where the model calls a tool instead of answering.
 */
export function toolCallStep(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = 'call-1',
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: mockUsage,
    warnings: [],
  };
}

/**
 * Builds a `MockLanguageModelV4` that returns the given steps in order, one
 * per `doGenerate` call — the eval-time stand-in for a real Ollama model.
 */
export function scriptedModel(steps: LanguageModelV4GenerateResult[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: steps });
}
