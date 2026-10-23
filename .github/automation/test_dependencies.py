"""Candidate dependencies, lifecycle separation, and fixed registry egress."""
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import registry
import run


class DependencyTests(unittest.TestCase):
    def test_candidate_manifest_lock_and_fresh_modules_are_used(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'package.json').write_text('{"dependencies":{"tiny":"1.0.0"}}')
            (root / 'pnpm-lock.yaml').write_text('candidate-lock')
            (root / 'node_modules').mkdir()
            (root / 'node_modules' / 'tampered').touch()
            calls = []
            def command(args, **kwargs):
                calls.append(args)
                self.assertFalse((root / 'node_modules' / 'tampered').exists())
                self.assertIn('tiny', (root / 'package.json').read_text())
                self.assertEqual((root / 'pnpm-lock.yaml').read_text(), 'candidate-lock')
                if len(calls) == 1:
                    (root / 'node_modules').mkdir()
                    (root / 'node_modules' / 'tiny').write_text('mock-registry-package')
                return SimpleNamespace(returncode=0)
            common = ['--mount', f'type=bind,src={root},dst=/work', '--user', '1000:1000', '--read-only']
            with patch.object(run.subprocess, 'run', command):
                run.prepare_dependencies(root, common, 'registry', 'deps-only', 'install', root)
            self.assertIn('deps-only', calls[0])
            self.assertIn('--ignore-scripts', calls[0])
            self.assertIn('--frozen-lockfile', calls[0])
            self.assertIn('none', calls[1])
            self.assertIn('rebuild', calls[1])
            self.assertEqual((root / 'node_modules' / 'tiny').read_text(), 'mock-registry-package')
            for args in calls:
                self.assertFalse(any('KEY' in arg or 'TOKEN' in arg or 'socket' in arg or '/trusted' in arg for arg in args))
                self.assertFalse(any('/opt/deps' in arg for arg in args))

    def test_preparation_failures_have_fixed_classification(self):
        for message, reason in [('ERR_PNPM_OUTDATED_LOCKFILE', 'dependency_mismatch'),
                                ('registry_denied 403', 'registry_denied'),
                                ('network private token', 'dependency_fetch_failed')]:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                def command(args, **kwargs):
                    kwargs['stdout'].write(message.encode())
                    return SimpleNamespace(returncode=1)
                with patch.object(run.subprocess, 'run', command), self.assertRaisesRegex(ValueError, reason):
                    run.prepare_dependencies(root, [], 'registry', 'deps-only', 'install', root)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(run.subprocess, 'run', side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=1)]), \
                    self.assertRaisesRegex(ValueError, 'install_script_failed'):
                run.prepare_dependencies(root, [], 'registry', 'deps-only', 'install', root)

    def test_registry_rejects_arbitrary_hosts_and_ports_before_connect(self):
        for target in ['attacker.invalid:443', 'registry.npmjs.org:80', 'registry.npmjs.org:443@evil',
                       'registry.npmjs.org.:443', '127.0.0.1:443']:
            handler = object.__new__(registry.RegistryProxy)
            handler.path = target
            handler.send_error = lambda *args: None
            with patch.object(registry.socket, 'create_connection') as connect:
                handler.do_CONNECT()
                connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
