import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolLoopAgent, tool, stepCountIs } from 'ai';
import { scriptedModel, textStep, toolCallStep } from '../src/harness/scripted-model.js';

/**
 * Proves the scripted-model harness works end to end with a real
 * `ToolLoopAgent`: a tool-call step followed by a text step, with no
 * network calls (plan §0/§3 — evals run offline).
 */
describe('scripted model smoke test', () => {
  it('runs a tool call then finishes with text', async () => {
    const model = scriptedModel([toolCallStep('echo', { text: 'hi' }), textStep('done: hi')]);

    const agent = new ToolLoopAgent({
      model,
      tools: {
        echo: tool({
          description: 'Echoes the given text back',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }: { text: string }) => ({ echoed: text }),
        }),
      },
      // Silences the default-step-limit warning; not exercising the real limit here.
      stopWhen: stepCountIs(3),
    });

    const result = await agent.generate({ prompt: 'say hi' });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.output).toEqual({ echoed: 'hi' });
    expect(result.text).toBe('done: hi');
    expect(model.doGenerateCalls.length).toBe(2);
  });
});
