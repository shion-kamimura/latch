import { expect, test } from 'vitest';
import { getHelp } from '../../src/help.js';

test('help describes usage and the current feature scope', () => {
  expect(getHelp()).toContain('Usage: latch [options]');
  expect(getHelp()).toContain('--help');
  expect(getHelp()).toContain('-v, --version');
  expect(getHelp()).toContain('latch plan');
  expect(getHelp()).toContain('--profile');
  expect(getHelp()).toContain('reports verification success');
});
