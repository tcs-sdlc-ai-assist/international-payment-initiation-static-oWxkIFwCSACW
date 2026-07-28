import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, afterAll, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

const REFERENCE_DATE = new Date(
  `${import.meta.env.VITE_REFERENCE_DATE ?? '2026-07-28'}T00:00:00.000Z`,
);

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(REFERENCE_DATE);
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  vi.useRealTimers();
});