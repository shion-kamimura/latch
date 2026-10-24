"""Candidate dependencies, lifecycle separation, and fixed registry egress."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import registry
import run


class DependencyTests(unittest.TestCase):
    def invoke(self, root, command, **kwargs):
        with patch.object(run.subprocess, 'run', command), patch.object(run, 'stop_container'), \
                contextlib.redirect_stdout(io.StringIO()):
            return run.prepare_dependencies(root, [], 'registry', 'deps-only', 'install', root, **kwargs)

    def test_candidate_manifest_lock_and_fresh_modules_are_used(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'package.json').write_text('{"packageManager":"pnpm@12.14.0","dependencies":{"tiny":"1.0.0"}}')
            (root / 'pnpm-lock.yaml').write_text('candidate-lock')
            for path in ['node_modules', 'packages/child/node_modules', '.pnpm-store', 'dist']:
                (root / path).mkdir(parents=True)
                (root / path / 'tampered').touch()
            calls = []
            def command(args, **kwargs):
                calls.append(args)
                if 'install' in args:
                    self.assertFalse((root / 'node_modules').exists())
                    self.assertFalse((root / 'packages/child/node_modules').exists())
                    self.assertFalse((root / '.pnpm-store').exists())
                    self.assertFalse((root / 'dist').exists())
                    self.assertIn('tiny', (root / 'package.json').read_text())
                    self.assertEqual((root / 'pnpm-lock.yaml').read_text(), 'candidate-lock')
                    (root / 'node_modules').mkdir()
                    (root / 'node_modules' / 'tiny').write_text('mock-registry-package')
                return SimpleNamespace(returncode=0)
            self.invoke(root, command)
            fetch = next(args for args in calls if 'install' in args)
            self.assertIn('deps-only', fetch)
            for option in ['--ignore-scripts', '--ignore-pnpmfile', '--frozen-lockfile', '--config.ignore-manifest-check=false']:
                self.assertIn(option, fetch)
            self.assertEqual(fetch[fetch.index('pnpm'):fetch.index('pnpm') + 3], ['pnpm', 'with', 'current'])
            self.assertIn('--config.side-effects-cache=false', fetch)
            self.assertIn('none', calls[-1])
            self.assertIn('rebuild', calls[-1])
            self.assertEqual((root / 'node_modules' / 'tiny').read_text(), 'mock-registry-package')
            for args in calls:
                self.assertFalse(any('KEY' in arg or 'TOKEN' in arg or 'socket' in arg or '/trusted' in arg for arg in args))
                self.assertFalse(any('/opt/deps' in arg for arg in args))

    def test_deterministic_failures_are_not_retried_and_are_safe(self):
        for message, reason in [('ERR_PNPM_OUTDATED_LOCKFILE', 'dependency_mismatch'),
                                ('ERR_PNPM_NO_LOCKFILE', 'dependency_mismatch'),
                                ('registry_denied 403', 'registry_denied'),
                                ('bad config private token', 'dependency_install_failed')]:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                calls = []
                def command(args, **kwargs):
                    calls.append(args)
                    kwargs['stdout'].write(message.encode())
                    return SimpleNamespace(returncode=1 if 'install' in args else 0)
                with self.assertRaisesRegex(ValueError, reason):
                    self.invoke(root, command)
                self.assertEqual(sum('install' in args for args in calls), 1)
                public = ''.join(p.read_text() for p in root.glob('*.safe.json'))
                self.assertNotIn('private', public)
                self.assertNotIn('token', public)

    def test_transport_timeout_retries_once_with_empty_store(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = []
            def command(args, **kwargs):
                if 'install' in args:
                    calls.append(args)
                    store = root / 'install-store'
                    self.assertFalse((store / 'corrupt').exists())
                    (store / 'corrupt').touch()
                    raise subprocess.TimeoutExpired(args, 300)
                return SimpleNamespace(returncode=0)
            with self.assertRaisesRegex(ValueError, 'dependency_fetch_timeout'):
                self.invoke(root, command)
            self.assertEqual(len(calls), 2)
            first = json.loads((root / 'dependency_fetch.safe.json').read_text())
            second = json.loads((root / 'dependency_fetch_retry1.safe.json').read_text())
            self.assertEqual(first['status'], 'timeout')
            self.assertEqual(second['attempt'], 2)
            self.assertEqual(second['cache'], 'retry_empty')

    def test_lifecycle_failure_is_never_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def command(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=1 if 'rebuild' in args else 0)
            with self.assertRaisesRegex(ValueError, 'install_script_failed'):
                self.invoke(Path(directory), command)
            self.assertEqual(sum('rebuild' in args for args in calls), 1)

    def test_runtime_mismatch_prevents_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def command(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=42)
            with self.assertRaisesRegex(ValueError, 'package_manager_mismatch'):
                self.invoke(Path(directory), command)
            self.assertFalse(any('install' in args for args in calls))
            record = json.loads(Path(directory, 'dependency_runtime.safe.json').read_text())
            self.assertEqual(record['reason'], 'package_manager_mismatch')

    def test_store_copy_and_rejected_symlink_cannot_mutate_saved_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = root / 'saved'; saved.mkdir()
            (saved / 'package').write_text('registry-content')
            clone = root / 'copy'
            self.assertTrue(run.clone_store(saved, clone))
            (clone / 'package').write_text('candidate-tampering')
            self.assertEqual((saved / 'package').read_text(), 'registry-content')
            (saved / 'escape').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(ValueError, 'invalid_store_entry'):
                run.clone_store(saved, root / 'rejected')

    def test_store_project_links_are_excluded_but_content_links_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            saved = root / 'saved'
            (saved / 'v11/projects').mkdir(parents=True)
            (saved / 'v11/files').mkdir()
            (saved / 'v11/projects/local').symlink_to('/work/node_modules')
            (saved / 'v11/files/content').write_text('registry-content')
            run.clone_store(saved, root / 'copy')
            self.assertFalse((root / 'copy/v11/projects').exists())
            self.assertEqual((root / 'copy/v11/files/content').read_text(), 'registry-content')
            (saved / 'v11/files/escape').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(ValueError, 'invalid_store_entry'):
                run.clone_store(saved, root / 'rejected')

    def test_preflight_failure_stops_before_gateway_or_ai_and_preserves_diagnostics(self):
        # Exercise main's orchestration, including its real finally/diagnostic path.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / 'issue.json'
            request.write_text(json.dumps({'number': 55, 'base': 'a' * 40}))
            calls = []
            def execute(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=0)
            env = {'DEEPSEEK_API_KEY': 'private', 'REQUEST_PATH': str(request), 'OUTPUT_PATH': str(root / 'out')}
            with patch.dict(os.environ, env), patch.object(run, 'validate_request'), \
                    patch.object(run.subprocess, 'check_output', return_value=self.empty_tar()), \
                    patch.object(run, 'execute', side_effect=execute), patch.object(run, 'verify_startup'), \
                    patch.object(run, 'preflight_dependencies', side_effect=ValueError('stage=dependencies error=registry_denied')), \
                    patch.object(run, 'report_gateway'), patch.object(run.subprocess, 'run', side_effect=execute), \
                    patch.object(run, 'run_agent') as agent, contextlib.redirect_stdout(io.StringIO()) as stdout:
                with self.assertRaisesRegex(ValueError, 'registry_denied'):
                    run.main()
            agent.assert_not_called()
            self.assertFalse(any('latch-gateway' in args for args in calls))
            self.assertIn('AI_API_not_called', stdout.getvalue())
            self.assertNotIn('private', stdout.getvalue())
            self.assertTrue((root / 'out/execution-summary.md').exists())

    @staticmethod
    def empty_tar():
        import tarfile
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w'):
            pass
        return buffer.getvalue()

    def test_metrics_publish_only_bounded_numeric_counters(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory, 'fetch.log')
            log.write_text('\n'.join([json.dumps({'downloaded': 4, 'reused': 9, 'added': 13, 'url': 'secret'}),
                                     json.dumps({'downloaded': 'secret', 'reused': -1, 'added': 999999999}), 'not json']))
            self.assertEqual(run.dependency_metrics(log), {'downloaded': 4, 'reused': 9, 'added': 13})

    def test_native_pnpm_metrics_deduplicate_progress_without_exposing_package_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory, 'fetch.log')
            events = [{'name': 'pnpm:progress', 'status': status, 'packageId': 'private-package'}
                      for status in ['resolved', 'fetched', 'fetched', 'found_in_store']]
            events.append({'name': 'pnpm:stats', 'added': 2})
            log.write_text('\n'.join(json.dumps(event) for event in events))
            self.assertEqual(run.dependency_metrics(log), {'downloaded': 1, 'reused': 1, 'added': 2})
            log.write_text('not json')
            self.assertEqual(run.dependency_metrics(log), {'downloaded': None, 'reused': None, 'added': None})

    def test_cache_key_tracks_base_tree_image_and_recipe(self):
        with patch.object(run.subprocess, 'check_output', side_effect=[b'a' * 40, b'node@sha256:one',
                b'b' * 40, b'node@sha256:one', b'a' * 40, b'node@sha256:two']), \
                patch.object(Path, 'read_bytes', return_value=b'trusted recipe'):
            keys = [run.dependency_cache_key() for _ in range(3)]
        self.assertEqual(len(set(keys)), 3)
        self.assertTrue(all(key.startswith('latch-base-store-v1-') for key in keys))
        self.assertTrue(all('nodev26.12.0-pnpm12.14.0' in key for key in keys))

    @unittest.skipUnless((Path(__file__).parents[1] / 'workflows/issue-draft-pr.yml').exists(),
                         'workflow not mounted in Python-only verifier')
    def test_workflow_cache_cannot_save_candidate_store_or_skip_install(self):
        workflow = (Path(__file__).parents[1] / 'workflows/issue-draft-pr.yml').read_text()
        restore = workflow.split('- name: Restore exact fixed-base pnpm store')[1].split('- name: Implement,')[0]
        save = workflow.split('- name: Save only fixed-base store; candidate stores are disposable')[1].split('- name: Save safe execution')[0]
        self.assertNotIn('restore-keys', restore)
        self.assertIn('base_store_ready', save)
        self.assertIn('runner.temp }}/base-pnpm-store', restore)
        self.assertIn('runner.temp }}/base-pnpm-store', save)
        self.assertNotIn('node_modules', save)
        self.assertNotIn('candidate-input', save)
        self.assertIn('continue-on-error: true', restore)
        self.assertIn('continue-on-error: true', save)

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
