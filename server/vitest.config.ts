import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { EvalsReporter } from './src/reporter/evals-reporter.js';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    reporters: [
      'default',
      new EvalsReporter({ outputPath: path.join(import.meta.dirname, '..', 'EVALS.md') }),
    ],
  },
});
