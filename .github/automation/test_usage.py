"""Usage measurements are counts, never copies of upstream content."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import gateway
import run

SECRET = 'private Authorization Bearer ::error::not-a-command'


class UsageTests(unittest.TestCase):
    def response(self, usage=None, finish='stop'):
        return {'usage': usage if usage is not None else {
            'prompt_tokens': 100, 'completion_tokens': 20,
            'prompt_cache_hit_tokens': 80, 'prompt_cache_miss_tokens': 20},
            'choices': [{'finish_reason': finish, 'message': {'content': SECRET}}]}

    def test_counts_cache_and_length_without_response_text(self):
        record = gateway.usage_record(self.response(finish='length'), 123)
        self.assertEqual(record['prompt_tokens'], 100)
        self.assertEqual(record['completion_tokens'], 20)
        self.assertEqual(record['cache_hit_tokens'], 80)
        self.assertEqual(record['cache_miss_tokens'], 20)
        self.assertEqual(record['finish_reason'], 'length')
        self.assertEqual(record['elapsed_ms'], 123)
        self.assertNotIn(SECRET, json.dumps(record))
        self.assertEqual(run.safe_usage_event(dict(record, private=SECRET)), record)

    def test_missing_usage_is_unknown_and_zero_usage_is_known(self):
        missing = gateway.usage_record({}, 1)
        self.assertIsNone(missing['prompt_tokens'])
        self.assertIsNone(missing['completion_tokens'])
        zero = gateway.usage_record(self.response({'prompt_tokens': 0, 'completion_tokens': 0}), 1)
        self.assertEqual(zero['prompt_tokens'], 0)
        self.assertEqual(zero['completion_tokens'], 0)
        self.assertIsNone(zero['cache_hit_tokens'])

    def test_malformed_or_untrusted_counts_are_not_logged(self):
        for usage in [SECRET, [], {'prompt_tokens': SECRET, 'completion_tokens': True},
                      {'prompt_tokens': -1, 'completion_tokens': 10_000_001}]:
            record = gateway.usage_record(self.response(usage), 1)
            self.assertIsNone(record['prompt_tokens'])
            self.assertIsNone(record['completion_tokens'])
            self.assertNotIn(SECRET, json.dumps(record))
        record = gateway.usage_record(self.response(finish={'private': SECRET}), 1)
        self.assertEqual(record['finish_reason'], 'unknown')

    def test_inconsistent_cache_counts_are_unknown(self):
        record = gateway.usage_record(self.response({'prompt_tokens': 100, 'completion_tokens': 20,
                                      'prompt_cache_hit_tokens': 100, 'prompt_cache_miss_tokens': 100}), 1)
        self.assertIsNone(record['cache_hit_tokens'])
        self.assertIsNone(record['cache_miss_tokens'])

    def test_host_rejects_bad_usage_event(self):
        valid = gateway.usage_record(self.response(), 1)
        for change in [{'finish_reason': SECRET}, {'elapsed_ms': SECRET}, {'prompt_tokens': True},
                       {'completed_at_unix': SECRET}]:
            self.assertIsNone(run.safe_usage_event(dict(valid, **change)))

    def test_success_artifact_is_sanitized_and_summarizes_partial_usage(self):
        status = {'event': 'api_status', 'outcome': 'success', 'received': 2, 'attempted': 2,
                  'http_status': 200}
        record = gateway.usage_record(self.response(finish='length'), 123)
        lines = [SECRET, json.dumps(dict(record, response=SECRET)), json.dumps(status)]
        result = subprocess.CompletedProcess([], 0, '\n'.join(lines), SECRET)
        with tempfile.TemporaryDirectory() as root, patch.object(run.subprocess, 'run', return_value=result), contextlib.redirect_stdout(io.StringIO()) as log:
            run.report_gateway('gateway', Path(root), 'proposal_ready', 2000)
            artifact = Path(root, 'diagnostics.json').read_text()
        self.assertNotIn(SECRET, artifact + log.getvalue())
        value = json.loads(artifact)
        self.assertEqual(value['summary']['prompt_tokens'], 100)
        self.assertEqual(value['summary']['completion_tokens'], 20)
        self.assertEqual(value['summary']['usage_unknown'], 1)
        self.assertEqual(value['summary']['cache_usage_unknown'], 1)
        self.assertEqual(value['summary']['output_truncations'], 1)
        self.assertEqual(value['outcome'], 'proposal_ready')
        self.assertEqual(value['limits']['requests'], 150)
        self.assertEqual(value['limits']['context_tokens'], 131072)

    def test_failure_artifact_records_limit_without_raw_error(self):
        event = {'event': 'api_status', 'outcome': 'rejected', 'received': 151, 'attempted': 150,
                 'http_status': 0, 'reason': 'request_limit', 'request_bytes': 400000,
                 'reserved': 20000000, 'reserved_limit': gateway.MAX_RESERVED, 'request_limit': 150}
        result = subprocess.CompletedProcess([], 0, json.dumps(event), SECRET)
        with tempfile.TemporaryDirectory() as root, patch.object(run.subprocess, 'run', return_value=result), contextlib.redirect_stdout(io.StringIO()):
            run.report_gateway('gateway', Path(root), 'failed', 2000, 'api_error')
            report = json.loads(Path(root, 'diagnostics.json').read_text())
        self.assertEqual(report['summary']['stop_reason'], 'request_limit')
        self.assertEqual(report['summary']['usage_unknown'], 150)
        self.assertIsNone(report['summary']['prompt_tokens'])
        self.assertEqual(report['outcome'], 'failed')
        self.assertEqual(report['limits']['requests'], 150)

    def test_unavailable_diagnostics_still_writes_failure_artifact(self):
        with tempfile.TemporaryDirectory() as root, patch.object(run.subprocess, 'run', side_effect=OSError(SECRET)), contextlib.redirect_stdout(io.StringIO()):
            run.report_gateway('gateway', Path(root), 'failed', 30000, 'timeout')
            text = Path(root, 'diagnostics.json').read_text()
        self.assertNotIn(SECRET, text)
        report = json.loads(text)
        self.assertFalse(report['diagnostics_available'])
        self.assertIsNone(report['summary']['usage_unknown'])
        self.assertEqual(report['summary']['stop_reason'], 'timeout')

    def test_metadata_is_numeric_and_never_copies_environment_text(self):
        status = {'event': 'api_status', 'outcome': 'ready', 'received': 0, 'attempted': 0, 'http_status': 0}
        result = subprocess.CompletedProcess([], 0, json.dumps(status), '')
        with tempfile.TemporaryDirectory() as root, patch.object(run.subprocess, 'run', return_value=result), patch.dict(run.os.environ, {'GITHUB_RUN_ID': SECRET, 'GITHUB_RUN_ATTEMPT': '2'}), contextlib.redirect_stdout(io.StringIO()):
            run.report_gateway('gateway', Path(root), 'no_changes', 100, issue_number=SECRET)
            text = Path(root, 'diagnostics.json').read_text()
        self.assertNotIn(SECRET, text)
        metadata = json.loads(text)['metadata']
        self.assertIsNone(metadata['github_run_id'])
        self.assertEqual(metadata['github_run_attempt'], 2)
        self.assertIsNone(metadata['issue_number'])

    def test_artifact_write_error_is_safe_and_does_not_raise(self):
        with patch.object(run.subprocess, 'run', side_effect=OSError(SECRET)), patch.object(run, 'write_diagnostics', side_effect=OSError(SECRET)), contextlib.redirect_stdout(io.StringIO()) as output:
            run.report_gateway('gateway', Path('/unused'))
        self.assertIn('stage=diagnostics error=write_failed', output.getvalue())
        self.assertNotIn(SECRET, output.getvalue())

    def test_failure_reason_never_returns_exception_text(self):
        self.assertEqual(run.failure_reason(ValueError(SECRET)), 'host_validation_failed')
        self.assertEqual(run.failure_reason(ValueError('stage=opencode_run error=timeout')), 'timeout')
        self.assertEqual(run.failure_reason(subprocess.TimeoutExpired([SECRET], 180)), 'validation_timeout')
