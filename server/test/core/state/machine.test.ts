import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@bellhop/shared/clock';
import { createLogger } from '@bellhop/shared/logger';
import { createStateMachine, canTransition, IllegalTransitionError, TRANSITIONS } from '../../../src/core/state/machine.js';
import { createTaskStateRepo } from '../../../src/core/repo/task-state.repo.js';
import type { TaskStateName } from '../../../src/core/types.js';
import { createTestDb, TEST_USER } from '../helpers.js';
import { createFakeTraceWriter } from '../../helpers/fake-trace.js';

const ALL_STATES: TaskStateName[] = [
  'GATHERING',
  'SEARCHING',
  'COMPARING',
  'PROPOSED',
  'APPROVED',
  'EXECUTING',
  'VERIFYING',
  'DONE',
  'FAILED',
  'LIMIT_EXCEEDED',
];

function setup() {
  const db = createTestDb();
  const clock = createFakeClock(Date.UTC(2026, 0, 1));
  const trace = createFakeTraceWriter();
  const logger = createLogger({ name: 'test', level: 'silent' });
  const machine = createStateMachine({ db, clock, trace, logger });
  const taskStateRepo = createTaskStateRepo(db);
  return { db, clock, trace, logger, machine, taskStateRepo };
}

describe('canTransition', () => {
  it('allows the forward chain', () => {
    const chain: TaskStateName[] = [
      'GATHERING',
      'SEARCHING',
      'COMPARING',
      'PROPOSED',
      'APPROVED',
      'EXECUTING',
      'VERIFYING',
      'DONE',
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(canTransition(chain[i]!, chain[i + 1]!)).toBe(true);
    }
  });

  it('allows the back-edges to PROPOSED', () => {
    expect(canTransition('APPROVED', 'PROPOSED')).toBe(true);
    expect(canTransition('EXECUTING', 'PROPOSED')).toBe(true);
    expect(canTransition('VERIFYING', 'PROPOSED')).toBe(true);
  });

  it('allows decline/alternatives edges back to SEARCHING', () => {
    expect(canTransition('COMPARING', 'SEARCHING')).toBe(true);
    expect(canTransition('PROPOSED', 'SEARCHING')).toBe(true);
  });

  it('allows any state to FAILED and to LIMIT_EXCEEDED', () => {
    for (const from of ALL_STATES) {
      if (from === 'FAILED') {
        expect(canTransition(from, 'LIMIT_EXCEEDED')).toBe(true);
      } else if (from === 'LIMIT_EXCEEDED') {
        expect(canTransition(from, 'FAILED')).toBe(true);
      } else {
        expect(canTransition(from, 'FAILED')).toBe(true);
        expect(canTransition(from, 'LIMIT_EXCEEDED')).toBe(true);
      }
    }
  });

  it('allows DONE/FAILED/LIMIT_EXCEEDED back to GATHERING for a new errand', () => {
    expect(canTransition('DONE', 'GATHERING')).toBe(true);
    expect(canTransition('FAILED', 'GATHERING')).toBe(true);
    expect(canTransition('LIMIT_EXCEEDED', 'GATHERING')).toBe(true);
  });

  it('rejects an edge not in the plan, e.g. GATHERING -> EXECUTING', () => {
    expect(canTransition('GATHERING', 'EXECUTING')).toBe(false);
  });

  it('rejects self-transitions', () => {
    for (const s of ALL_STATES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('every target in TRANSITIONS is one of the 10 known states', () => {
    for (const targets of Object.values(TRANSITIONS)) {
      for (const t of targets) {
        expect(ALL_STATES).toContain(t);
      }
    }
  });
});

describe('createStateMachine.transition', () => {
  it('walks the full happy chain, persisting state + updated_at and tracing each hop', () => {
    const { machine, taskStateRepo, clock, trace } = setup();
    const chain: TaskStateName[] = [
      'GATHERING',
      'SEARCHING',
      'COMPARING',
      'PROPOSED',
      'APPROVED',
      'EXECUTING',
      'VERIFYING',
      'DONE',
    ];

    for (let i = 1; i < chain.length; i++) {
      clock.advance(1_000);
      const result = machine.transition(TEST_USER, chain[i]!);
      expect(result.state).toBe(chain[i]);
      expect(taskStateRepo.get(TEST_USER)?.state).toBe(chain[i]);
    }

    expect(trace.events).toHaveLength(chain.length - 1);
    expect(trace.events[0]).toMatchObject({ type: 'state_transition', from: 'GATHERING', to: 'SEARCHING' });
  });

  it('treats a missing task_state row as GATHERING', () => {
    const { machine, taskStateRepo } = setup();
    expect(taskStateRepo.get(TEST_USER)).toBeUndefined();

    machine.transition(TEST_USER, 'SEARCHING');

    expect(taskStateRepo.get(TEST_USER)?.state).toBe('SEARCHING');
  });

  it.each([
    ['APPROVED', 'PROPOSED'],
    ['EXECUTING', 'PROPOSED'],
    ['VERIFYING', 'PROPOSED'],
  ] as const)('back-edge %s -> %s is allowed and persisted', (from, to) => {
    const { machine, taskStateRepo } = setup();
    // Drive to `from` via the forward chain first.
    const chain: TaskStateName[] = ['SEARCHING', 'COMPARING', 'PROPOSED', 'APPROVED', 'EXECUTING', 'VERIFYING'];
    for (const step of chain) {
      machine.transition(TEST_USER, step);
      if (step === from) break;
    }

    const result = machine.transition(TEST_USER, to, 'material change');
    expect(result.state).toBe(to);
    expect(taskStateRepo.get(TEST_USER)?.state).toBe(to);
  });

  it.each(ALL_STATES)('%s -> FAILED is allowed', (from) => {
    const { machine } = setup();
    if (from !== 'GATHERING') {
      // Reach `from` first via a direct (allowed) edge where possible, else via FAILED/LIMIT_EXCEEDED's own reachable states.
      const path: TaskStateName[] = ['SEARCHING', 'COMPARING', 'PROPOSED', 'APPROVED', 'EXECUTING', 'VERIFYING', 'DONE'];
      if (from === 'FAILED') {
        machine.transition(TEST_USER, 'LIMIT_EXCEEDED');
        const result = machine.transition(TEST_USER, 'FAILED');
        expect(result.state).toBe('FAILED');
        return;
      }
      if (from === 'LIMIT_EXCEEDED') {
        const result = machine.transition(TEST_USER, 'LIMIT_EXCEEDED');
        expect(result.state).toBe('LIMIT_EXCEEDED');
        expect(canTransition('LIMIT_EXCEEDED', 'FAILED')).toBe(true);
        return;
      }
      for (const step of path) {
        machine.transition(TEST_USER, step);
        if (step === from) break;
      }
    }

    const result = machine.transition(TEST_USER, 'FAILED');
    expect(result.state).toBe('FAILED');
  });

  it('LIMIT_EXCEEDED is reachable from GATHERING directly', () => {
    const { machine } = setup();
    const result = machine.transition(TEST_USER, 'LIMIT_EXCEEDED');
    expect(result.state).toBe('LIMIT_EXCEEDED');
  });

  it('an illegal transition throws IllegalTransitionError and leaves the row untouched', () => {
    const { machine, taskStateRepo } = setup();
    machine.transition(TEST_USER, 'SEARCHING');
    const before = taskStateRepo.get(TEST_USER);

    expect(() => machine.transition(TEST_USER, 'EXECUTING')).toThrow(IllegalTransitionError);
    expect(taskStateRepo.get(TEST_USER)).toEqual(before);
  });

  it('an illegal transition does not write a trace event', () => {
    const { machine, trace } = setup();
    machine.transition(TEST_USER, 'SEARCHING');
    const countBefore = trace.events.length;

    expect(() => machine.transition(TEST_USER, 'EXECUTING')).toThrow(IllegalTransitionError);
    expect(trace.events).toHaveLength(countBefore);
  });

  it('DONE -> GATHERING starts a new errand', () => {
    const { machine } = setup();
    for (const step of ['SEARCHING', 'COMPARING', 'PROPOSED', 'APPROVED', 'EXECUTING', 'VERIFYING', 'DONE'] as const) {
      machine.transition(TEST_USER, step);
    }

    const result = machine.transition(TEST_USER, 'GATHERING');
    expect(result.state).toBe('GATHERING');
  });

  it('includes the reason on the trace event', () => {
    const { machine, trace } = setup();
    machine.transition(TEST_USER, 'SEARCHING', 'user asked for a plumber');

    expect(trace.events[0]).toMatchObject({ reason: 'user asked for a plumber' });
  });
});
