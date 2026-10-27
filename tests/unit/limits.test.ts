import { afterEach, expect, test, vi } from 'vitest';
import { formatLimit, startTimeout } from '../../src/limits.js';

afterEach(() => vi.useRealTimers());

test('an unlimited operation has no deadline timer', () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const stop = startTimeout(null, expired);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(120_001);
  expect(expired).not.toHaveBeenCalled();
  stop();
  expect(formatLimit(null, 'ms')).toBe('なし');
});

test('an explicitly selected deadline can expire or be cancelled', () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const stop = startTimeout(1000, expired);
  vi.advanceTimersByTime(999);
  expect(expired).not.toHaveBeenCalled();
  stop();
  vi.advanceTimersByTime(1);
  expect(expired).not.toHaveBeenCalled();
  startTimeout(1000, expired);
  vi.advanceTimersByTime(1000);
  expect(expired).toHaveBeenCalledOnce();
});

test('long deadlines do not expire early when a Node timer would overflow', () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  startTimeout(2 ** 31 + 100, expired);
  vi.advanceTimersByTime(2 ** 31 - 1);
  expect(expired).not.toHaveBeenCalled();
  vi.advanceTimersByTime(101);
  expect(expired).toHaveBeenCalledOnce();
});
