import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { runCli } from '../../src/run-cli.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

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

test.each([{ args: ['--version'] }, { args: ['-v'] }])(
  'prints the package version for $args',
  ({ args }) => {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(runCli(args, io)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(`${packageJson.version}\n`);
    expect(io.stderr).not.toHaveBeenCalled();
  },
);

test('help lists the version option', () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(runCli(['--help'], io)).toBe(0);
  expect(io.stdout).toHaveBeenCalledWith(
    expect.stringContaining('-v, --version'),
  );
});

test('rejects unsupported arguments through stderr', () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(runCli(['--unknown'], io)).toBe(1);
  expect(io.stdout).not.toHaveBeenCalled();
  expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('--help'));
});

test('rejects version combined with other arguments', () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(runCli(['--version', '--help'], io)).toBe(1);
  expect(io.stdout).not.toHaveBeenCalled();
  expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('--help'));
});
