import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { __resetMockApiForTests } from '../api/mock.js';

afterEach(() => {
  vi.restoreAllMocks();
  __resetMockApiForTests();
});
