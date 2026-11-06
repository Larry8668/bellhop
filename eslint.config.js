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
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        AbortController: 'readonly',
        Blob: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        EventSource: 'readonly',
        Headers: 'readonly',
        HTMLElement: 'readonly',
        MessageEvent: 'readonly',
        Navigator: 'readonly',
        Performance: 'readonly',
        ReadableStream: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        WritableStream: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        performance: 'readonly',
        queueMicrotask: 'readonly',
        sessionStorage: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    files: [
      'web/**/*.test.{ts,tsx}',
      'web/**/*.spec.{ts,tsx}',
      'web/test/**/*.{ts,tsx}',
    ],
    languageOptions: {
      globals: {
        afterAll: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        describe: 'readonly',
        expect: 'readonly',
        it: 'readonly',
        test: 'readonly',
        vi: 'readonly',
      },
    },
  },
  {
    files: ['web/src/dev/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
);
