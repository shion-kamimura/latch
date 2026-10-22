"""Partial results survive ordinary failures, after candidate termination."""
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import policy
import publish
import run


class PartialTests(unittest.TestCase):
    def exercise(self, agent_error=None, check_failure=False, dependency_error=None, unsafe=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = {'number': 1, 'base': 'a' * 40, 'branch': 'feat/automated-' + 'b' * 16,
                       'title': 'test', 'body': 'test'}
            request_path = root / 'issue.json'
            request_path.write_text(json.dumps(request))
            output = root / 'out'
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w') as tar:
                data = b'{"scripts": {"test": "test"}}'
                info = tarfile.TarInfo('package.json')
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            events = []
            work_path = []
            def agent(command, *args):
                mount = next(arg for arg in command if arg.startswith('type=bind,src=') and arg.endswith('dst=/work'))
                work = Path(mount.split('src=')[1].split(',')[0])
                work_path.append(work)
                (work / 'new.ts').write_text('API_KEY=' + 'a' * 40 if unsafe else 'export {};')
                events.append('edited')
                if agent_error:
                    raise ValueError('stage=opencode_run error=' + agent_error)
            def stop(name):
                events.append('stopped')
            def snapshot(path):
                if work_path:
                    self.assertIn('stopped', events)
                return original_snapshot(path)
            original_snapshot = run.snapshot
            def check(*args):
                return run.check_result('failed' if check_failure else 'passed', 1 if check_failure else 0, 'exit_code')
            patches = [patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'dummy', 'REQUEST_PATH': str(request_path), 'OUTPUT_PATH': str(output)}),
                       patch.object(run.subprocess, 'check_output', return_value=archive.getvalue()),
                       patch.object(run.subprocess, 'run', return_value=SimpleNamespace(returncode=0)),
                       patch.object(run, 'execute'), patch.object(run, 'verify_startup'),
                       patch.object(run, 'run_agent', side_effect=agent), patch.object(run, 'stop_container', side_effect=stop),
                       patch.object(run, 'snapshot', side_effect=snapshot), patch.object(run, 'report_gateway'),
                       patch.object(run, 'independent_check', side_effect=check),
                       patch.object(run, 'prepare_dependencies', side_effect=dependency_error)]
            import contextlib
            with contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                if agent_error or check_failure or dependency_error or unsafe:
                    with self.assertRaises(ValueError):
                        run.main()
                else:
                    run.main()
            if unsafe:
                self.assertFalse((output / 'proposal.json').exists())
                self.assertEqual(json.loads((output / 'policy.json').read_text())['reason'], 'secret_detected')
            else:
                value = json.loads((output / 'proposal.json').read_text())
                self.assertEqual(publish.validate(value)[0]['path'], 'new.ts')
                self.assertEqual(value['implementation'], agent_error or 'completed')
                if dependency_error:
                    self.assertEqual(value['checks']['test']['status'], 'not_run')
                if check_failure:
                    self.assertEqual(value['checks']['test']['status'], 'failed')

    def test_success_and_safe_partial_outcomes(self):
        self.exercise()
        for reason in ['timeout', 'abnormal_exit', 'api_error']:
            self.exercise(agent_error=reason)
        self.exercise(check_failure=True)
        self.exercise(dependency_error=ValueError('stage=dependencies error=dependency_fetch_failed'))

    def test_unsafe_partial_never_produces_artifact(self):
        self.exercise(agent_error='timeout', unsafe=True)

    def test_timeout_stops_verifier_before_returning_result(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(run.subprocess, 'run',
                side_effect=subprocess.TimeoutExpired(['docker'], 180)), patch.object(run, 'stop_container') as stop:
            result = run.independent_check(['docker'], Path(directory) / 'log', 'verifier')
            self.assertEqual(result['status'], 'timeout')
            stop.assert_called_once_with('verifier')

    def test_paths_and_exception_messages_are_not_copied_to_diagnostics(self):
        error = policy.PolicyError('forbidden_path', 'folder/ghp_' + 'a' * 40)
        self.assertEqual(error.path, '[redacted path]')
        self.assertNotIn('ghp_', str(error))
        self.assertEqual(run.failure_reason(ValueError('secret raw exception')), 'host_validation_failed')

    def test_source_change_after_checks_refuses_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'src.ts').write_text('original')
            generated = run.snapshot(root)
            (root / 'src.ts').write_text('changed during verification')
            with self.assertRaises(policy.PolicyError):
                run.save_proposal(root, {}, root, generated, [], {}, 'completed')
            self.assertFalse((root / 'proposal.json').exists())


if __name__ == '__main__':
    unittest.main()
