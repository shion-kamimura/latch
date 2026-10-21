import { expect, test, vi } from 'vitest';
import { runCli } from '../../src/run-cli.js';

test.each([{ args: [] }, { args: ['--help'] }, { args: ['-h'] }])(
  'routes $args to help output',
  ({ args }) => {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(runCli(args, io)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(
      expect.stringContaining('Usage: latch'),
    );
    expect(io.stderr).not.toHaveBeenCalled();
  },
);

test('rejects unsupported arguments through stderr', () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(runCli(['verify'], io)).toBe(1);
  expect(io.stdout).not.toHaveBeenCalled();
  expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('--help'));
});
