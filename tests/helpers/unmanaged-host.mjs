// Process fixture for the fake CLI E2E tests: simulate an unmanaged Linux host.
// Never used with the real Codex binary or shipped in the product bundle.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.lstatSync;
const policyPaths = new Set([
  '/etc/codex/config.toml',
  '/etc/codex/requirements.toml',
  '/etc/codex/managed_config.toml',
]);
fs.lstatSync = function (path, options) {
  if (policyPaths.has(String(path)))
    throw Object.assign(new Error('absent policy fixture'), { code: 'ENOENT' });
  return original(path, options);
};
syncBuiltinESMExports();
