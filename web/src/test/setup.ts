import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { __resetMockApiForTests } from '../api/mock.js';

afterEach(() => {
  __resetMockApiForTests();
});
