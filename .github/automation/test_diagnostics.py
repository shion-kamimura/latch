"""Safe diagnostics exercise real handlers with a mocked upstream, never live keys."""

import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch
import urllib.error

import gateway
import run


SECRET = 'secret-key Authorization: Bearer private ::error::private-response'


class DiagnosticsTests(unittest.TestCase):
    def test_startup_failure_and_timeout_hide_subprocess_output(self):
        for result in [subprocess.CompletedProcess([], 1, SECRET, SECRET),
                       subprocess.TimeoutExpired(['opencode', SECRET], 30, SECRET, SECRET)]:
            with self.subTest(result=type(result).__name__):
                kwargs = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
                with patch.object(run.subprocess, 'run', **kwargs), self.assertRaises(ValueError) as error:
                    run.verify_startup(['opencode', '--version'])
                self.assertIn('stage=opencode_startup', str(error.exception))
                self.assertNotIn(SECRET, str(error.exception))

    def test_run_errors_and_success_are_classified_without_messages(self):
        cases = [
            (1, SECRET, 'abnormal_exit'),
            (127, SECRET, 'startup_error'),
            (1, 'ConfigInvalidError: ' + SECRET, 'configuration_error'),
            (0, json.dumps({'type': 'error', 'error': {'name': 'APICallError', 'message': SECRET}}), 'api_error'),
            (0, json.dumps({'type': 'error', 'error': {'name': SECRET}}), 'agent_error'),
            (0, json.dumps({'type': 'error', 'error': {'name': {'private': SECRET}}}), 'agent_error'),
            (1, json.dumps({'type': 'error', 'error': {'name': 'ProviderModelNotFoundError'}}), 'model_configuration_error'),
            (0, json.dumps({'type': 'text', 'part': {'text': SECRET}}), None),
        ]
        for code, transcript, kind in cases:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                def fake_run(_command, **kwargs):
                    kwargs['stdout'].write(transcript.encode())
                    return subprocess.CompletedProcess([], code)
                with patch.object(run.subprocess, 'run', side_effect=fake_run), contextlib.redirect_stdout(io.StringIO()) as output:
                    if kind:
                        with self.assertRaisesRegex(ValueError, 'error=' + kind) as error:
                            run.run_agent(['opencode'], Path(root, 'agent.log'))
                        self.assertNotIn(SECRET, str(error.exception))
                    else:
                        run.run_agent(['opencode'], Path(root, 'agent.log'))
                self.assertNotIn(SECRET, output.getvalue())

    def test_agent_timeout_has_safe_stage(self):
        with tempfile.TemporaryDirectory() as root, patch.object(run.subprocess, 'run',
                side_effect=subprocess.TimeoutExpired(['opencode', SECRET], 1200, SECRET, SECRET)):
            with self.assertRaisesRegex(ValueError, '^stage=opencode_run error=timeout limit_seconds=1200$'):
                run.run_agent(['opencode'], Path(root, 'log'))

    def request(self, upstream=None, payload=None):
        handler = gateway.Handler.__new__(gateway.Handler)
        raw = json.dumps(payload or {'model': gateway.MODEL, 'messages': [{'content': SECRET}]}).encode()
        handler.path = '/v1/chat/completions'
        handler.headers = {'Content-Length': str(len(raw)), 'Authorization': SECRET}
        handler.rfile = io.BytesIO(raw)
        handler.reply = Mock()
        gateway.Handler.budget = gateway.Budget()
        gateway.Handler.received = gateway.Handler.attempted = 0
        opener = MagicMock()
        if isinstance(upstream, Exception):
            opener.open.side_effect = upstream
        else:
            response = Mock(status=200)
            response.read.return_value = upstream or b'{"choices": []}'
            opener.open.return_value.__enter__.return_value = response
        with patch.dict(gateway.os.environ, {'DEEPSEEK_API_KEY': SECRET}), patch.object(
                gateway.urllib.request, 'build_opener', return_value=opener), contextlib.redirect_stdout(io.StringIO()) as output:
            gateway.Handler.status('ready')
            handler.do_POST()
        self.assertNotIn(SECRET, output.getvalue())
        return [json.loads(line) for line in output.getvalue().splitlines()], handler, opener

    def test_gateway_records_attempt_and_http_status_without_body(self):
        cases = [
            (None, 'success', 200),
            (urllib.error.HTTPError('https://private', 401, SECRET, {}, io.BytesIO(SECRET.encode())), 'http_error', 401),
            (urllib.error.HTTPError('https://private', 429, SECRET, {}, None), 'http_error', 429),
            (TimeoutError(SECRET), 'timeout', 0),
            (urllib.error.URLError(TimeoutError(SECRET)), 'timeout', 0),
            (urllib.error.URLError(SECRET), 'transport_error', 0),
            (SECRET.encode(), 'invalid_response', 200),
        ]
        for upstream, outcome, status in cases:
            with self.subTest(outcome=outcome):
                events, handler, opener = self.request(upstream)
                self.assertEqual(events[0], {'event': 'api_status', 'outcome': 'ready', 'received': 0,
                                             'attempted': 0, 'http_status': 0})
                self.assertEqual(events[1]['outcome'], 'attempt')
                self.assertEqual(events[-1]['outcome'], outcome)
                self.assertEqual(events[-1]['http_status'], status)
                self.assertEqual(events[-1]['attempted'], 1)
                self.assertEqual(opener.open.call_args.kwargs['timeout'], 120)

    def test_rejected_payload_never_attempts_api(self):
        events, handler, opener = self.request(payload={'model': SECRET})
        self.assertEqual(events[-1]['outcome'], 'rejected')
        self.assertEqual(events[-1]['attempted'], 0)
        opener.open.assert_not_called()
        handler.reply.assert_called_once_with(400, {'error': 'Invalid payload or API budget exhausted'})

    def test_gateway_report_only_emits_allowlisted_fields(self):
        events = [SECRET, json.dumps({'event': 'api_status', 'received': 1, 'attempted': 1,
                  'http_status': 401, 'outcome': 'http_error', 'body': SECRET}),
                  json.dumps({'event': 'api_status', 'received': 1, 'attempted': 1,
                  'http_status': 200, 'outcome': SECRET}),
                  json.dumps({'event': 'api_status', 'received': 1, 'attempted': 1,
                  'http_status': 200, 'outcome': {'private': SECRET}}), '[]']
        result = subprocess.CompletedProcess([], 0, '\n'.join(events), SECRET)
        with patch.object(run.subprocess, 'run', return_value=result), contextlib.redirect_stdout(io.StringIO()) as output:
            run.report_gateway('gateway')
        self.assertEqual(output.getvalue(), 'stage=api outcome=http_error received=1 attempted=1 http_status=401\n')

    def test_gateway_report_unavailable_does_not_mask_original_failure(self):
        with patch.object(run.subprocess, 'run', side_effect=subprocess.TimeoutExpired([SECRET], 10)), contextlib.redirect_stdout(io.StringIO()) as output:
            run.report_gateway('gateway')
        self.assertEqual(output.getvalue(), 'stage=api error=diagnostics_unavailable\n')


if __name__ == '__main__':
    unittest.main()
