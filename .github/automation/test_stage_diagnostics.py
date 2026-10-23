"""Stage failures retain bounded metadata, never candidate output or credentials."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import run


class StageDiagnosticsTests(unittest.TestCase):
    def test_fetch_and_lifecycle_timeouts_preserve_distinct_stages(self):
        for fail_at, expected in [(1, 'dependency_fetch'), (2, 'dependency_lifecycle')]:
            with self.subTest(stage=expected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                calls = []
                def command(args, **kwargs):
                    calls.append(args)
                    kwargs['stdout'].write(b'Authorization: Bearer private ::error::secret')
                    if len(calls) == fail_at:
                        raise subprocess.TimeoutExpired(args, kwargs['timeout'], output=b'secret')
                    return subprocess.CompletedProcess(args, 0)
                with patch.object(run.subprocess, 'run', side_effect=command), contextlib.redirect_stdout(io.StringIO()) as stdout:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        run.prepare_dependencies(root, [], 'registry', 'network', 'install', root)
                result = json.loads((root / (expected + '.safe.json')).read_text())
                self.assertEqual((result['stage'], result['status'], result['reason']), (expected, 'timeout', 'time_limit'))
                self.assertEqual(result['limit_seconds'], 300 if fail_at == 1 else 180)
                self.assertIsNone(result['exit_code'])
                out = root / 'out'
                out.mkdir()
                summary = root / 'summary'
                with patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(summary), 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2'}):
                    run.save_execution(out, root, {'number': 54, 'base': 'a' * 40}, {'test': run.check_result(reason='dependencies_unavailable')}, {}, {})
                public = stdout.getvalue() + summary.read_text() + ''.join(p.read_text() for p in (out / 'stages').iterdir())
                self.assertNotIn('secret', public)
                self.assertNotIn('Authorization', public)
                self.assertIn('issue-diagnostics-123-2', public)
                self.assertIn('dependencies_unavailable', public)
                for p in (out / 'stages').iterdir():
                    self.assertLessEqual(p.stat().st_size, 4096)
                if fail_at == 2:
                    self.assertEqual(json.loads((out / 'stages/dependency_fetch.safe.json').read_text())['status'], 'passed')

    def test_real_process_failure_records_exit_without_relaying_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, 'lint.log')
            with patch.object(run, 'stop_container'), contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = run.independent_check(['python3', '-c', 'print("private credential"); raise SystemExit(7)'], path, 'container')
            self.assertEqual(result, run.check_result('failed', 7, 'exit_code'))
            record = json.loads(path.with_suffix('.safe.json').read_text())
            self.assertEqual((record['status'], record['exit_code']), ('failed', 7))
            self.assertNotIn('private', stdout.getvalue())
            self.assertEqual(record['raw_log_limit_bytes'], run.LOG_LIMIT_BYTES)

    def test_raw_log_capacity_is_enforced_in_child_process(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, 'lint.log')
            with patch.object(run, 'LOG_LIMIT_BYTES', 1024), contextlib.redirect_stdout(io.StringIO()):
                result = run.diagnostic_command(['python3', '-c', 'import os; os.write(1, b"x" * 8192); os.write(1, b"x")'], path, 'lint', 10)
            self.assertNotEqual(result.returncode, 0)
            self.assertLessEqual(path.stat().st_size, 1024)

    def test_api_replay_exposes_occurrence_and_emit_times_without_body(self):
        line = '2026-10-23T12:34:56.000000000Z ' + json.dumps({'event': 'api_status', 'outcome': 'success', 'received': 1, 'attempted': 1, 'http_status': 200, 'body': 'private'})
        with patch.object(run.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, line)), contextlib.redirect_stdout(io.StringIO()) as stdout:
            run.report_gateway('gateway', since=123)
        self.assertIn('occurred_at=2026-10-23T12:34:56', stdout.getvalue())
        self.assertIn('emitted_at=', stdout.getvalue())
        self.assertIn('mode=live', stdout.getvalue())
        self.assertNotIn('private', stdout.getvalue())

    @unittest.skipUnless((Path(__file__).parents[1] / 'workflows/issue-draft-pr.yml').exists(),
                         'workflow not mounted in Python-only verifier')
    def test_workflow_retention_and_upload_allowlist(self):
        workflow = Path(__file__).parents[1] / 'workflows/issue-draft-pr.yml'
        text = workflow.read_text()
        section = text.split('- name: Save safe execution measurements even on failure')[1].split('- name: Check safe proposal availability')[0]
        self.assertIn('if: always()', section)
        self.assertIn('retention-days: 14', section)
        self.assertIn('/stages/*.safe.json', section)
        self.assertNotIn('*.log', section)
        self.assertRegex(text, r'''run-name: ["']Issue #\$\{\{ inputs.issue_number \}\}''')

    def test_progress_emits_while_process_is_running(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(run, 'HEARTBEAT_SECONDS', 0.01), contextlib.redirect_stdout(io.StringIO()) as stdout:
            run.diagnostic_command(['python3', '-c', 'import time; time.sleep(0.1)'],
                                   Path(directory, 'lint.log'), 'lint', 10)
        records = [json.loads(line.split('stage=execution ', 1)[1]) for line in stdout.getvalue().splitlines()]
        self.assertGreater(len(records), 2)
        self.assertEqual(records[0]['status'], 'running')
        self.assertGreater(records[-2]['elapsed_ms'], 0)
        self.assertEqual(records[-1]['status'], 'passed')

    def test_live_api_polling_stops_at_agent_exit(self):
        with patch.object(run, 'HEARTBEAT_SECONDS', 0.01), patch.object(run, 'report_gateway') as report:
            with run.live_gateway('gateway'):
                time.sleep(0.06)
            count = report.call_count
            self.assertGreater(count, 0)
            self.assertIn('since', report.call_args.kwargs)
            time.sleep(0.03)
            self.assertEqual(report.call_count, count)

    def test_oversized_sidecars_are_excluded_and_digest_covers_deletions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'oversized.safe.json').write_bytes(b'x' * 4097)
            out = root / 'out'
            out.mkdir()
            request = {'number': 54, 'base': 'a' * 40, 'source': 'b' * 40}
            before = {'deleted.ts': run.SourceFile('c' * 64, '100644', root)}
            with patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(root / 'summary')}):
                run.save_execution(out, root, request, {}, {}, before)
                deletion = (out / 'execution-summary.md').read_text()
                run.save_execution(out, root, request, {}, {}, {})
                unchanged = (out / 'execution-summary.md').read_text()
            self.assertFalse((out / 'stages/oversized.safe.json').exists())
            self.assertNotEqual(deletion, unchanged)
            self.assertIn('Verification source: `' + 'b' * 40, deletion)
            self.assertNotIn('deleted.ts', deletion)
