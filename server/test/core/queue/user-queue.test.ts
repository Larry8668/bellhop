import { createLogger } from '@bellhop/shared/logger';
import { describe, expect, it } from 'vitest';
import { createUserQueue } from '../../../src/core/queue/user-queue.js';

const silent = createLogger({ name: 'user-queue-test', level: 'silent' });

/** Resolves after `ms` of real time — tiny delays are enough to interleave scheduling without slowing the suite. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createUserQueue', () => {
  it('runs tasks for one user in strict FIFO order even when pushed out of order with varying delays', async () => {
    const queue = createUserQueue({ logger: silent });
    const order: string[] = [];

    const a = queue.run('u1', 'a', async () => {
      await delay(15);
      order.push('a');
    });
    const b = queue.run('u1', 'b', async () => {
      await delay(1);
      order.push('b');
    });
    const c = queue.run('u1', 'c', async () => {
      order.push('c');
    });

    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('keeps two users fully independent — one user is never blocked by the other', async () => {
    const queue = createUserQueue({ logger: silent });
    const order: string[] = [];

    // u2's single task starts after u1's slow first task, but must not wait
    // for u1's *second* task — queues are per-user, not global.
    const u1a = queue.run('u1', 'u1a', async () => {
      await delay(20);
      order.push('u1a');
    });
    const u1b = queue.run('u1', 'u1b', async () => {
      order.push('u1b');
    });
    const u2a = queue.run('u2', 'u2a', async () => {
      order.push('u2a');
    });

    await u2a;
    expect(order).toEqual(['u2a']);

    await Promise.all([u1a, u1b]);
    expect(order).toEqual(['u2a', 'u1a', 'u1b']);
  });

  it('isolates a rejection: the failing task is reported to its own caller, the next task still runs', async () => {
    const queue = createUserQueue({ logger: silent });
    const order: string[] = [];

    const failing = queue.run('u1', 'failing', async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const next = queue.run('u1', 'next', async () => {
      order.push('next');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(order).toEqual(['failing', 'next']);
  });

  it('size tracks queued + running tasks for a user and drains to 0 once everything settles', async () => {
    const queue = createUserQueue({ logger: silent });
    expect(queue.size('u1')).toBe(0);

    const a = queue.run('u1', 'a', async () => {
      await delay(10);
    });
    const b = queue.run('u1', 'b', async () => {
      await delay(10);
    });
    expect(queue.size('u1')).toBe(2);

    await a;
    expect(queue.size('u1')).toBe(1);

    await b;
    expect(queue.size('u1')).toBe(0);
  });

  it('size stays 0 for a user who never queued anything, and drains even after a rejection', async () => {
    const queue = createUserQueue({ logger: silent });
    expect(queue.size('ghost')).toBe(0);

    const failing = queue.run('u1', 'failing', async () => {
      throw new Error('boom');
    });
    await failing.catch(() => {});
    expect(queue.size('u1')).toBe(0);
  });
});
