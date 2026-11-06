import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.delegate/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'error',
    },
  },
  {
    // `**/` prefix so this also matches a workspace's own scripts dir
    // (e.g. `server/scripts/*`), not just the repo-root `scripts/`.
    files: ['**/scripts/**/*'],
    rules: {
      'no-console': 'off',
    },
  },
);
