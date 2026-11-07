import { repairToolCallFor } from './repair.js';
import type Database from 'better-sqlite3';
import { stepCountIs, ToolLoopAgent, type LanguageModel, type ModelMessage } from 'ai';
import type { Clock } from '@bellhop/shared/clock';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import { describeOutcome, type ExecutionOutcome } from '../core/actions/outcomes.js';
import type { CoreEngine } from '../core/engine.js';
import { createCoreEngine } from '../core/engine.js';
import { newId } from '../core/ids.js';
import { createConversationsRepo, createMessagesRepo } from '../core/repo/index.js';
import { canTransition } from '../core/state/machine.js';
import type { Message, TaskState, TaskStateName } from '../core/types.js';
import type { ProviderClient } from '../provider-client/index.js';
import { estimateCostUsd } from '../trace/cost.js';
import { createTraceWriter } from '../trace/writer.js';
import { buildTurnContext, estimateTokens } from './context.js';
import { buildAgentTools, createToolBudget, createTurnFlags, type TurnFlags } from './tools.js';
import type { HarnessEvent, HarnessMemory } from './types.js';

/** Plan §9 starting budget. chars/4, checked in `prepareStep`. */
const CONTEXT_BUDGET_TOKENS = 8192;
const HISTORY_MESSAGES = 40;

const TYPED_YES = new Set([
  'yes',
  'yes please',
  'yep',
  'yeah',
  'confirm',
  'confirmed',
  'book it',
  'go ahead',
  'do it',
  'please book',
  'please confirm',
]);

const CLAIMS_DONE =
  /\b(you(?:'re| are) booked|i(?:'ve| have) booked|i booked|has been booked|booking(?: is)? confirmed|went ahead and)\b/i;

const MODEL_LIMIT_REPLY =
  'I stopped because this turn reached the model-call limit. Nothing was booked. Tell me the service, area, and time if you want me to try again.';
const TOOL_LIMIT_REPLY =
  'I stopped because this turn reached the tool-call limit. Nothing was booked.';
const WALL_LIMIT_REPLY = 'I stopped because this turn ran out of time. Nothing was booked.';
const RETRIES_REPLY = 'I could not finish that after several tries, so nothing was changed. Please try again.';
const FAILED_REPLY = 'Something went wrong before anything was changed. Please try again.';
const ASK_REPLY = 'I still need the service, the area, and when you need it.';
const PROPOSAL_REPLY = 'I have a proposal ready. Nothing is booked until you confirm it.';
const CLAIM_REPLY = 'Nothing was booked. I can only propose a booking; it happens after you confirm.';
const CLAIM_PROPOSED_REPLY =
  'I have a proposal ready, but nothing is booked until you confirm it. Reply yes if that proposal is the one you want.';

export type TurnExit = 'ok' | 'needs_input' | 'proposed' | 'limit_reached' | 'failed' | 'booked' | 'unconfirmed';

export interface TurnLimits {
  modelCalls: number;
  toolCalls: number;
  wallClockMs: number;
  statusChecks: number;
  retriesPerTool: number;
}

export interface RunTurnDeps {
  db: Database.Database;
  clock: Clock;
  model: LanguageModel;
  providerClient: ProviderClient;
  logger: Logger;
  tracesDir: string;
  limits: TurnLimits;
  memory?: HarnessMemory | undefined;
  onEvent?: ((event: HarnessEvent) => void) | undefined;
}

export interface TurnInput {
  userId: string;
  text: string;
}

export interface TurnResult {
  reply: string;
  exit: TurnExit;
  runId: string;
  proposalId?: string;
}

function isTypedYes(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ').replace(/[.!]+$/g, '').toLowerCase();
  return TYPED_YES.has(normalized);
}

function isAbortError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const name = 'name' in current ? String((current as { name: unknown }).name) : '';
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function missingFacts(task: TaskState | undefined): boolean {
  if (task === undefined) return true;
  return task.service == null || task.area == null || (task.window_from == null && task.window_to == null);
}

function exitForOutcome(outcome: ExecutionOutcome): TurnExit {
  switch (outcome.kind) {
    case 'booked':
      return 'booked';
    case 'unconfirmed':
      return 'unconfirmed';
    case 'needs_reapproval':
      return 'proposed';
    case 'slot_gone':
      return 'needs_input';
    case 'cancelled':
    case 'rescheduled':
      return 'ok';
    case 'rejected':
    case 'failed':
      return 'failed';
  }
}

const PROPOSAL_CLAIM = /\b(i(?:'ll| will| have|'ve)? propos|proposed|confirm (?:it )?on the card|approval card|please confirm)/i;
const PROPOSAL_NUDGE =
  '(Bellhop system) You described a proposal but did not call propose_booking, so no card exists. ' +
  'Call propose_booking now with the exact provider_id and slot from the search results, or ask the user which option they want.';
const NO_CARD_REPLY =
  "I haven't prepared a booking card yet. Tell me which provider and time you'd like, and I'll put it up for you to confirm.";

function guardModelReply(reply: string, exit: TurnExit): string {
  if (exit !== 'proposed' && PROPOSAL_CLAIM.test(reply) && !reply.includes('?')) return NO_CARD_REPLY;
  if (exit === 'booked' || exit === 'unconfirmed' || exit === 'limit_reached' || exit === 'failed') return reply;
  if (!CLAIMS_DONE.test(reply)) return reply;
  return exit === 'proposed' ? CLAIM_PROPOSED_REPLY : CLAIM_REPLY;
}

function toModelMessage(message: Message): ModelMessage | undefined {
  if (message.role === 'user') return { role: 'user', content: message.text };
  if (message.role === 'assistant') return { role: 'assistant', content: message.text };
  return undefined;
}

function estimateToolSchemas(tools: Record<string, { description?: unknown }>): number {
  let chars = 0;
  for (const [name, item] of Object.entries(tools)) {
    chars += name.length;
    if (typeof item.description === 'string') chars += item.description.length;
  }
  return estimateTokens(chars > 0 ? 'x'.repeat(chars) : '') + Object.keys(tools).length * 80;
}

/**
 * One user turn (plan §9). The model never approves: a typed yes is checked
 * here, against exactly one pending unexpired proposal, and executed with
 * that proposal's own hash — the same approve-then-execute path as the API.
 */
export async function runTurn(deps: RunTurnDeps, input: TurnInput): Promise<TurnResult> {
  const { userId, text } = input;
  const runId = newId('turn');
  const log = childLogger(deps.logger, 'harness', { run_id: runId, userId });
  const trace = createTraceWriter({ dir: deps.tracesDir, runId, clock: deps.clock });
  const engine = createCoreEngine({
    db: deps.db,
    clock: deps.clock,
    providerClient: deps.providerClient,
    trace,
    logger: log,
    limits: { statusChecks: deps.limits.statusChecks, retriesPerTool: deps.limits.retriesPerTool },
    requestId: runId,
  });
  const conversations = createConversationsRepo(deps.db);
  const messages = createMessagesRepo(deps.db);
  const startedMs = deps.clock.nowMs();
  const conversation = conversations.ensureConversation(userId, new Date(startedMs).toISOString());

  engine.taskState.upsert(userId, {
    conversation_id: conversation.id,
    run_id: runId,
    updated_at: new Date(startedMs).toISOString(),
  });

  const prior = messages.listRecent(userId, HISTORY_MESSAGES);
  // The injected clock may not move during a turn. Sequence off the previous
  // message so history stays chronological without touching hold expiry.
  const lastMs = prior.length === 0 ? startedMs - 1 : Date.parse(prior[prior.length - 1]?.created_at ?? '');
  const userMs = Math.max(startedMs, (Number.isNaN(lastMs) ? startedMs : lastMs) + 1);
  messages.append({
    id: newId('msg'),
    conversation_id: conversation.id,
    user_id: userId,
    role: 'user',
    text,
    proposal_id: null,
    created_at: new Date(userMs).toISOString(),
  });

  const emit = (event: HarnessEvent): void => {
    deps.onEvent?.(event);
  };

  function move(to: TaskStateName, reason: string): void {
    const from = engine.taskState.get(userId)?.state ?? 'GATHERING';
    if (from === to) return;
    if (!canTransition(from, to)) {
      log.warn({ from, to, reason }, 'skipped state transition');
      return;
    }
    engine.stateMachine.transition(userId, to, reason);
  }

  function finish(reply: string, exit: TurnExit, proposalId?: string): TurnResult {
    const stored = reply.trim().length > 0 ? reply.trim() : FAILED_REPLY;
    messages.append({
      id: newId('msg'),
      conversation_id: conversation.id,
      user_id: userId,
      role: 'assistant',
      text: stored,
      proposal_id: proposalId ?? null,
      created_at: new Date(userMs + 1).toISOString(),
    });
    emit({ ts: deps.clock.now().toISOString(), type: 'turn', summary: exit, detail: { exit } });
    log.info({ exit, proposalId }, 'turn finished');
    if (proposalId === undefined) return { reply: stored, exit, runId };
    return { reply: stored, exit, runId, proposalId };
  }

  try {
    const typed = await confirmTypedYes(engine, userId, text, log);
    if (typed !== undefined) {
      if (typed.exit === 'failed') {
        trace.emit({ type: 'error', where: 'harness', message: typed.reply });
      }
      return typed.proposalId === undefined
        ? finish(typed.reply, typed.exit)
        : finish(typed.reply, typed.exit, typed.proposalId);
    }

    const flags = createTurnFlags();
    const budget = createToolBudget(deps.limits.toolCalls);
    const tools = buildAgentTools({
      userId,
      runId,
      engine,
      providerClient: deps.providerClient,
      trace,
      clock: deps.clock,
      logger: log,
      retriesPerTool: deps.limits.retriesPerTool,
      budget,
      flags,
      onEvent: deps.onEvent,
      memory: deps.memory,
    });
    const toolsTokens = estimateToolSchemas(tools);
    const history: ModelMessage[] = [];
    for (const message of prior) {
      const modelMessage = toModelMessage(message);
      if (modelMessage !== undefined) history.push(modelMessage);
    }
    history.push({ role: 'user', content: text });

    const signal = AbortSignal.timeout(deps.limits.wallClockMs);
    const agent = new ToolLoopAgent({
      model: deps.model,
      tools,
      stopWhen: [
        stepCountIs(deps.limits.modelCalls),
        () => budget.exceeded || flags.retriesExhausted || flags.unexpected,
      ],
      maxRetries: 0,
      temperature: 0,
      toolCallConcurrency: 1,
      repairToolCall: repairToolCallFor(userId),
      prepareStep: ({ messages: stepMessages, stepNumber }) => {
        const built = buildTurnContext({
          userId,
          runId,
          step: stepNumber,
          messages: stepMessages,
          task: engine.taskState.get(userId),
          budgetTokens: CONTEXT_BUDGET_TOKENS,
          toolsTokens,
          memory: deps.memory,
          logger: log,
          now: deps.clock.now(),
        });
        return { instructions: built.instructions, messages: built.messages };
      },
      onStepFinish: (step) => {
        const tokensIn = step.usage.inputTokens ?? 0;
        const tokensOut = step.usage.outputTokens ?? 0;
        const latencyMs = step.performance.responseTimeMs;
        trace.emit({
          type: 'model_call',
          model: step.model.modelId,
          latency_ms: latencyMs,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          est_cost_usd: estimateCostUsd(step.model.modelId, tokensIn, tokensOut),
          finish_reason: step.finishReason,
        });
        emit({
          ts: deps.clock.now().toISOString(),
          type: 'model_call',
          summary: `model ${step.finishReason}`,
          detail: { tokensIn, tokensOut, latencyMs },
        });
        for (const call of step.toolCalls) {
          if (!('invalid' in call) || call.invalid !== true) continue;
          const allowed = budget.tryConsume();
          const error = call.error instanceof Error ? call.error.message : 'invalid tool arguments';
          trace.emit({
            type: 'tool_call',
            tool: call.toolName,
            args: call.input,
            result_sanitized: { error },
            latency_ms: 0,
            ok: false,
          });
          emit({
            ts: deps.clock.now().toISOString(),
            type: 'tool_call',
            summary: `${call.toolName} invalid`,
            detail: { tool: call.toolName, ok: false, counted: allowed },
          });
          log.warn({ tool: call.toolName, runId }, 'invalid tool call');
        }
      },
    });

    let result = await agent.generate({
      messages: history,
      abortSignal: signal,
    });
    // Small local models sometimes *say* they proposed without calling propose_booking.
    // One code-driven nudge to make the real tool call; otherwise the reply is corrected below.
    if (
      !signal.aborted &&
      flags.proposalId === undefined &&
      !budget.exceeded &&
      !flags.retriesExhausted &&
      !flags.unexpected &&
      result.steps.length < deps.limits.modelCalls &&
      PROPOSAL_CLAIM.test(result.text)
    ) {
      log.info({ runId }, 'model claimed a proposal without calling propose_booking; nudging once');
      emit({ ts: deps.clock.now().toISOString(), type: 'model_call', summary: 'nudge: proposal claimed without tool call' });
      result = await agent.generate({
        messages: [...history, ...result.response.messages, { role: 'user', content: PROPOSAL_NUDGE }],
        abortSignal: signal,
      });
    }
    if (signal.aborted) {
      move('LIMIT_EXCEEDED', 'wall clock');
      return finish(WALL_LIMIT_REPLY, 'limit_reached');
    }
    return finishModelTurn(result, flags, budget.exceeded, deps.limits.modelCalls, engine, userId, move, finish);
  } catch (err) {
    if (isAbortError(err)) {
      log.warn({ err, runId }, 'turn aborted');
      move('LIMIT_EXCEEDED', 'wall clock');
      return finish(WALL_LIMIT_REPLY, 'limit_reached');
    }
    log.error({ err, runId }, 'turn failed');
    trace.emit({
      type: 'error',
      where: 'harness',
      message: err instanceof Error ? err.message : 'turn failed',
    });
    move('FAILED', 'turn failed');
    return finish(FAILED_REPLY, 'failed');
  }
}

interface TypedOutcome {
  reply: string;
  exit: TurnExit;
  proposalId?: string;
}

/**
 * Code, not the model, decides a typed yes (plan §7). The hash is the
 * proposal's current hash. Expired and missing proposals are not approved.
 */
async function confirmTypedYes(
  engine: CoreEngine,
  userId: string,
  text: string,
  log: Logger,
): Promise<TypedOutcome | undefined> {
  if (!isTypedYes(text)) return undefined;
  const pending = engine.proposals.listPending(userId);
  if (pending.length === 0) return undefined;
  const live = pending.filter((proposal) => !proposal.expired);
  if (live.length !== 1) {
    log.info({ userId, pending: pending.length, live: live.length }, 'typed yes did not match one live proposal');
    if (live.length === 0) {
      return {
        reply: 'The hold on that proposal expired, so I did not confirm it. Nothing was booked. Ask me to propose it again.',
        exit: 'needs_input',
      };
    }
    return {
      reply: 'There is more than one pending proposal, so I did not confirm any of them.',
      exit: 'needs_input',
    };
  }
  const proposal = live[0];
  if (proposal === undefined) return undefined;
  const approved = engine.approvals.approve(userId, {
    proposal_id: proposal.id,
    hash: proposal.hash,
    source: 'typed',
  });
  if (!approved.ok) {
    log.warn({ userId, proposalId: proposal.id, reason: approved.reason }, 'typed yes rejected');
    return {
      reply: `I couldn't confirm that (${approved.reason}), so nothing was changed.`,
      exit: 'failed',
    };
  }
  const outcome = await engine.executor.execute(userId, approved.approval.id);
  const proposalId = outcome.kind === 'needs_reapproval' ? outcome.proposal.id : proposal.id;
  log.info({ userId, proposalId, kind: outcome.kind, source: 'typed' }, 'typed yes executed');
  return { reply: describeOutcome(outcome), exit: exitForOutcome(outcome), proposalId };
}

function finishModelTurn(
  result: { text: string; finishReason: string; steps: unknown[] },
  flags: TurnFlags,
  toolLimit: boolean,
  modelCallLimit: number,
  engine: CoreEngine,
  userId: string,
  move: (to: TaskStateName, reason: string) => void,
  finish: (reply: string, exit: TurnExit, proposalId?: string) => TurnResult,
): TurnResult {
  let exit: TurnExit = 'ok';
  let reply = result.text.trim();
  if (toolLimit) {
    exit = 'limit_reached';
    reply = TOOL_LIMIT_REPLY;
    move('LIMIT_EXCEEDED', 'tool-call limit');
  } else if (result.steps.length >= modelCallLimit && result.finishReason === 'tool-calls') {
    exit = 'limit_reached';
    reply = MODEL_LIMIT_REPLY;
    move('LIMIT_EXCEEDED', 'model-call limit');
  } else if (flags.retriesExhausted) {
    exit = 'failed';
    reply = RETRIES_REPLY;
    move('FAILED', 'retries exhausted');
  } else if (flags.unexpected || result.finishReason === 'error') {
    exit = 'failed';
    reply = FAILED_REPLY;
    move('FAILED', 'unexpected tool error');
  } else if (flags.proposalId !== undefined) {
    exit = 'proposed';
    if (reply.length === 0) reply = PROPOSAL_REPLY;
  } else if (reply.length === 0 || reply.includes('?') || missingFacts(engine.taskState.get(userId))) {
    exit = 'needs_input';
    if (reply.length === 0) reply = ASK_REPLY;
  }
  reply = guardModelReply(reply, exit);
  return flags.proposalId === undefined ? finish(reply, exit) : finish(reply, exit, flags.proposalId);
}
