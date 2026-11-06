import type { ExecutionLimits } from '../../src/core/actions/executor.js';

/** Shared default `ExecutionLimits` for every MCP test harness in this directory. */
export const DEFAULT_MCP_TEST_LIMITS: ExecutionLimits = { statusChecks: 3, retriesPerTool: 2 };
