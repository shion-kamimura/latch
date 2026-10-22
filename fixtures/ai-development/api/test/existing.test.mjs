import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDuration } from '../src/api.mjs';

test('non-negative input keeps existing behavior', () => {
  assert.deepEqual(handleDuration('/duration?ms=5'), {
    status: 200,
    duration: '5ms',
  });
  assert.deepEqual(handleDuration('/duration?ms=0'), {
    status: 200,
    duration: '0ms',
  });
});
