/**
 * Extends Vitest's per-test `meta` with the fields the EVALS reporter
 * reads (`server/src/reporter/evals-reporter.ts`). Tests set these inside
 * the test body: `test('S09 …', ({ task }) => { task.meta.expected = '…'; })`.
 *
 * `export {}` makes this file a module, not a global script — without it,
 * `declare module 'vitest'` below would *replace* vitest's real ambient
 * module instead of augmenting it, wiping out every existing export.
 */
export {};

declare module 'vitest' {
  interface TaskMeta {
    expected?: string;
    actual?: string;
    notes?: string;
  }
}
