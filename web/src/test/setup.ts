import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { __resetMockApiForTests } from '../api/mock.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetMockApiForTests();
});
