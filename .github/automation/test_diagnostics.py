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
            with self.assertRaisesRegex(ValueError, '^stage=opencode_run error=timeout limit_seconds=3600$'):
                run.run_agent(['opencode'], Path(root, 'log'))

    def request(self, upstream=None, payload=None, reset=True):
        handler = gateway.Handler.__new__(gateway.Handler)
        raw = json.dumps(payload or {'model': gateway.MODEL, 'messages': [{'content': SECRET}]}).encode()
        handler.path = '/v1/chat/completions'
        handler.headers = {'Content-Length': str(len(raw)), 'Authorization': SECRET}
        handler.rfile = io.BytesIO(raw)
        handler.reply = Mock()
        if reset:
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
        return [json.loads(line) for line in output.getvalue().splitlines() if json.loads(line)['event'] == 'api_status'], handler, opener

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
                                             'attempted': 0, 'http_status': 0, 'reason': 'none',
                                             'request_bytes': 0, 'reserved': 0,
                                             'reserved_limit': gateway.MAX_RESERVED,
                                             'request_limit': gateway.MAX_REQUESTS})
                statuses = [event for event in events if event['event'] == 'api_status']
                self.assertEqual(statuses[1]['outcome'], 'attempt')
                self.assertEqual(statuses[-1]['outcome'], outcome)
                self.assertEqual(statuses[-1]['http_status'], status)
                self.assertEqual(statuses[-1]['attempted'], 1)
                self.assertEqual(opener.open.call_args.kwargs['timeout'], 120)

    def test_request_limit_allows_500_attempts_then_rejects_without_spending(self):
        pricing = dict(gateway.DEFAULT_COST_CONFIG, limit_usd='1000')
        for upstream, outcome in [
                (None, 'success'),
                (urllib.error.HTTPError('https://private', 429, SECRET, {}, None), 'http_error'),
                (TimeoutError(SECRET), 'timeout')]:
            with self.subTest(outcome=outcome), patch.object(gateway, 'DEFAULT_COST_CONFIG', pricing), patch.object(gateway, 'DEFAULT_MODEL_CONFIG', dict(gateway.DEFAULT_MODEL_CONFIG, requests=500)):
                reserved = 0
                for attempt in range(1, 501):
                    events, handler, opener = self.request(upstream, reset=attempt == 1)
                    opener.open.assert_called_once()
                    statuses = [event for event in events if event['event'] == 'api_status']
                    self.assertEqual(statuses[-1]['outcome'], outcome)
                    self.assertEqual(statuses[-1]['attempted'], attempt)
                    self.assertEqual(statuses[-1]['request_limit'], 500)
                    self.assertEqual(handler.budget.requests, attempt)
                    reserved += len(opener.open.call_args.args[0].data)
                    self.assertEqual(handler.budget.reserved, reserved)
                before = (handler.budget.requests, handler.budget.reserved, handler.attempted)
                events, handler, opener = self.request(upstream, reset=False)
                opener.open.assert_not_called()
                self.assertEqual(events[-1]['reason'], 'request_limit')
                self.assertEqual(events[-1]['request_limit'], 500)
                self.assertEqual(events[-1]['received'], 501)
                self.assertEqual(events[-1]['attempted'], 500)
                self.assertEqual(events[-1]['reserved'], reserved)
                self.assertEqual((handler.budget.requests, handler.budget.reserved, handler.attempted), before)
                handler.reply.assert_called_once_with(400, {'error': 'request_limit'})

    def test_rejected_payload_never_attempts_api(self):
        events, handler, opener = self.request(payload={'model': SECRET})
        self.assertEqual(events[-1]['outcome'], 'rejected')
        self.assertEqual(events[-1]['attempted'], 0)
        opener.open.assert_not_called()
        handler.reply.assert_called_once_with(400, {'error': 'Invalid payload or API budget exhausted'})

    def test_budget_rejection_reason_and_counters_never_forward_request(self):
        for field, limit, reason in [('MAX_BYTES', 1, 'invalid_request_size')]:
            with self.subTest(reason=reason), patch.object(gateway, field, limit):
                events, handler, opener = self.request()
                self.assertEqual(events[-1]['reason'], reason)
                self.assertEqual(events[-1]['attempted'], 0)
                self.assertEqual(events[-1]['reserved'], 0)
                opener.open.assert_not_called()
                handler.reply.assert_called_once_with(400, {'error': reason})

    def test_budget_rejects_without_changing_accounting(self):
        budget = gateway.Budget()
        for size, expected in [(gateway.MAX_BYTES + 1, 'request_too_large')]:
            with self.assertRaises(gateway.Rejected) as error:
                budget.reserve(size)
            self.assertEqual(error.exception.reason, expected)
        with patch.object(gateway, 'MAX_RESERVED', 10):
            budget.reserve(10)
            budget.reserve(1)
            self.assertEqual((budget.requests, budget.reserved), (2, 11))
            self.assertIn('cumulative_bytes', budget.warnings)

    def test_cost_rejection_never_attempts_upstream(self):
        pricing = dict(gateway.DEFAULT_COST_CONFIG, limit_usd='0.1')
        with patch.object(gateway, 'DEFAULT_COST_CONFIG', pricing):
            events, handler, opener = self.request()
        self.assertEqual(events[-1]['reason'], 'cost_limit')
        self.assertEqual((handler.budget.requests, handler.budget.reserved), (0, 0))
        opener.open.assert_not_called()
        handler.reply.assert_called_once_with(400, {'error': 'cost_limit'})

    def test_transport_errors_and_invalid_responses_keep_monetary_reservation(self):
        for response in [TimeoutError(SECRET), SECRET.encode(),
                         urllib.error.HTTPError('https://private', 500, SECRET, {}, None)]:
            events, handler, _ = self.request(response)
            self.assertEqual(handler.budget.held, handler.budget.maximum_cost())
            self.assertEqual(handler.budget.estimated, 0)
            self.assertEqual(events[-1]['attempted'], 1)

    def test_compact_utf8_preserves_payload_and_existing_budget_limits(self):
        payload = {'model': gateway.MODEL, 'messages': [{'role': 'user', 'content': '日本語の要件' * 100}],
                   'tools': [{'type': 'function', 'function': {'name': 'read', 'description': '読取' * 100}}]}
        body = gateway.prepare_request(json.dumps(payload).encode())
        value = json.loads(body)
        self.assertEqual(value['messages'], payload['messages'])
        self.assertEqual(value['tools'], payload['tools'])
        self.assertLess(len(body), len(json.dumps(value).encode()))
        budget = gateway.Budget()
        budget.reserve(len(body))
        self.assertEqual(budget.reserved, len(body))
        self.assertEqual((gateway.MAX_BYTES, gateway.MAX_REQUESTS, gateway.MAX_RESERVED),
                         (16_777_216, 10000, 268_435_456))

    def test_previously_rejected_eleventh_request_fits_new_budget(self):
        budget = gateway.Budget()
        for size in [5988, 31367, 34216, 41305, 43399, 43795, 53006, 55153, 59716, 60538]:
            budget.reserve(size)
        self.assertEqual(budget.reserved, 469443 - 10 * 4096)
        budget.reserve(61006)
        self.assertEqual((budget.requests, budget.reserved), (11, 534545 - 11 * 4096))

    def test_new_budget_stops_at_exact_limit_without_spending_on_rejection(self):
        budget = gateway.Budget()
        while gateway.MAX_RESERVED - budget.reserved > gateway.MAX_BYTES:
            budget.reserve(gateway.MAX_BYTES)
        budget.reserve(gateway.MAX_RESERVED - budget.reserved)
        self.assertEqual(budget.reserved, gateway.MAX_RESERVED)
        budget.reserve(1)
        self.assertGreater(budget.reserved, gateway.MAX_RESERVED)
        self.assertIn('cumulative_bytes', budget.warnings)

    def test_budget_report_filters_reason_and_numeric_fields(self):
        event = {'event': 'api_status', 'outcome': 'rejected', 'received': 11, 'attempted': 10,
                 'http_status': 0, 'reason': 'reserved_limit', 'request_bytes': 50000,
                 'reserved': 1980000, 'reserved_limit': 2000000, 'request_limit': 24}
        for change, expected in [({}, True), ({'reason': SECRET}, False), ({'reserved': SECRET}, False), ({'reserved': 1_000_000_000_001}, False), ({'reserved': True}, False)]:
            result = subprocess.CompletedProcess([], 0, json.dumps(dict(event, **change)), '')
            with patch.object(run.subprocess, 'run', return_value=result), contextlib.redirect_stdout(io.StringIO()) as output:
                run.report_gateway('gateway')
            self.assertEqual('stage=api_budget reason=reserved_limit' in output.getvalue(), expected)
            self.assertNotIn(SECRET, output.getvalue())
            if expected:
                self.assertIn('reserved=1980000 reserved_limit=2000000', output.getvalue())

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
