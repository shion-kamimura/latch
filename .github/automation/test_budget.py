"""Operational limits and estimated spending are independent, fail-closed counters."""

import contextlib
from decimal import Decimal
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import agent_metrics
import gateway
import run


class BudgetTests(unittest.TestCase):
    def usage(self, prompt=100, output=20, hit=80, miss=20):
        return gateway.usage_record({'usage': {'prompt_tokens': prompt, 'completion_tokens': output,
            'prompt_cache_hit_tokens': hit, 'prompt_cache_miss_tokens': miss}}, 1)

    def test_limits_and_previous_32_mib_failure(self):
        self.assertEqual((gateway.MAX_REQUESTS, gateway.MAX_BYTES, gateway.MAX_RESERVED,
                          run.AGENT_TIMEOUT), (500, 1024**2, 256 * 1024**2, 3600))
        budget = gateway.Budget()
        for _ in range(147):
            reservation = budget.authorize(240000)
            budget.settle(self.usage(prompt=60000, hit=50000, miss=10000), reservation)
        self.assertGreater(budget.reserved, 32 * 1024**2)
        self.assertEqual(budget.requests, 147)

    def test_80_percent_warns_and_100_percent_accepts_then_rejects(self):
        for field, value, label in [('MAX_REQUESTS', 5, 'requests'),
                                     ('MAX_RESERVED', 5, 'cumulative_bytes'),
                                     ('MAX_BYTES', 5, 'request_bytes')]:
            with self.subTest(field=field), patch.object(gateway, field, value):
                budget = gateway.Budget()
                if field == 'MAX_BYTES':
                    budget.reserve(3)
                    self.assertNotIn(label, budget.warnings)
                    budget.reserve(4)
                    self.assertIn(label, budget.warnings)
                    budget.reserve(5)
                    with self.assertRaises(gateway.Rejected):
                        budget.reserve(6)
                else:
                    for _ in range(3):
                        budget.reserve(1)
                    self.assertNotIn(label, budget.warnings)
                    budget.reserve(1)
                    self.assertIn(label, budget.warnings)
                    budget.reserve(1)
                    with self.assertRaises(gateway.Rejected):
                        budget.reserve(1)

    def test_exact_cost_boundary_and_warning_continue(self):
        base = gateway.Budget()
        pricing = dict(gateway.DEFAULT_COST_CONFIG, limit_usd=str(base.maximum_cost() * 5))
        budget = gateway.Budget(pricing)
        for _ in range(3):
            budget.authorize(1)
        self.assertNotIn('cost', budget.warnings)
        budget.authorize(1)
        self.assertIn('cost', budget.warnings)
        budget.authorize(1)
        before = budget.record(), budget.requests, budget.reserved
        with self.assertRaisesRegex(gateway.Rejected, 'cost_limit'):
            budget.authorize(1)
        self.assertEqual((budget.record(), budget.requests, budget.reserved), before)

    def test_cache_prices_and_unknown_cache(self):
        for hit, miss, expected in [(80, 20, '0.00003048'),
                                     (None, None, '0.000054')]:
            budget = gateway.Budget()
            amount = budget.authorize(1)
            budget.settle(self.usage(hit=hit, miss=miss), amount)
            self.assertEqual(budget.estimated, Decimal(expected))
            self.assertEqual(budget.held, 0)

    def test_missing_usage_keeps_reservation_and_invalid_usage_stops(self):
        for record, stopped in [(gateway.usage_record({}, 1), False),
                                (self.usage(prompt=gateway.MAX_CONTEXT + 1), True),
                                (self.usage(output=gateway.MAX_OUTPUT + 1), True)]:
            budget = gateway.Budget()
            amount = budget.authorize(1)
            budget.settle(record, amount)
            self.assertEqual(budget.held, amount)
            self.assertEqual(budget.estimated, 0)
            self.assertEqual(budget.stopped, stopped)
            if stopped:
                with self.assertRaisesRegex(gateway.Rejected, 'cost_limit'):
                    budget.authorize(1)

    def test_price_changes_affect_reservation_and_estimate(self):
        budget = gateway.Budget(dict(gateway.DEFAULT_COST_CONFIG, output_usd_per_million='2.4'))
        self.assertEqual(budget.maximum_cost(), Decimal('0.3196608'))
        amount = budget.authorize(1)
        budget.settle(self.usage(), amount)
        self.assertEqual(budget.estimated, Decimal('0.00005448'))

    def test_operator_config_is_validated_without_echoing_input(self):
        for raw in ['private-secret', '{}', '[]', json.dumps(dict(gateway.DEFAULT_COST_CONFIG,
                    limit_usd='NaN')), json.dumps(dict(gateway.DEFAULT_COST_CONFIG, limit_usd='0')),
                    json.dumps(dict(gateway.DEFAULT_COST_CONFIG, hit_usd_per_million='1'))]:
            with self.assertRaisesRegex(ValueError, '^Invalid cost configuration$'):
                gateway.cost_config(raw)

    def test_full_budget_diagnostics_are_sanitized_above_100mb(self):
        budget = gateway.Budget()
        budget.authorize(1)
        budget.reserved = 200_000_000
        budget.warn('cumulative_bytes', budget.reserved, gateway.MAX_RESERVED)
        status = {'event': 'api_status', 'outcome': 'rejected', 'received': 501,
                  'attempted': 500, 'http_status': 0, 'reason': 'cost_limit',
                  'request_bytes': 1, 'reserved': budget.reserved,
                  'reserved_limit': gateway.MAX_RESERVED, 'request_limit': gateway.MAX_REQUESTS}
        record = dict(budget.record(), private='private-secret')
        result = subprocess.CompletedProcess([], 0, '\n'.join(map(json.dumps, [status, record])), '')
        with tempfile.TemporaryDirectory() as root, patch.object(run.subprocess, 'run', return_value=result), contextlib.redirect_stdout(io.StringIO()):
            run.report_gateway('gateway', Path(root))
            raw = Path(root, 'diagnostics.json').read_text()
        summary = json.loads(raw)['summary']
        self.assertEqual(summary['cumulative_request_bytes'], 200_000_000)
        self.assertEqual(summary['stop_reason'], 'cost_limit')
        self.assertEqual(summary['cost']['held_usd'], str(budget.held))
        self.assertNotIn('private-secret', raw)
        for change in [{'estimated_usd': 'private-secret'}, {'held_usd': 'NaN'},
                       {'warnings': ['private-secret']}, {'accounting_exceeded': 'private-secret'}]:
            self.assertIsNone(run.safe_budget_event(dict(record, **change)))

    def test_compaction_config_and_private_session_counts(self):
        config = json.loads(run.agent_config('gateway'))
        self.assertEqual(config['compaction'], {'auto': True, 'prune': True})
        counts = agent_metrics.session_counts({'messages': [
            {'info': {'summary': True, 'time': {'completed': 1}},
             'parts': [{'type': 'text', 'text': 'private-secret'}]},
            {'info': {'summary': True, 'error': 'private-secret'}, 'parts': []},
            {'info': {}, 'parts': [{'type': 'tool', 'state': {'time': {'compacted': 1},
                                                        'output': 'private-secret'}}]}]})
        self.assertEqual(counts, {'event': 'agent_metrics', 'compactions': 1, 'pruned_tools': 1})
        with tempfile.TemporaryDirectory() as root:
            log = Path(root, 'agent.log')
            log.write_text('private-secret\n' + json.dumps(dict(counts, private='private-secret')))
            self.assertEqual(run.read_agent_metrics(log), {'compactions': 1, 'pruned_tools': 1})
        self.assertEqual(run.read_agent_metrics('/missing'), {'compactions': None, 'pruned_tools': None})

    def test_agent_time_warning_and_timeout_configuration(self):
        warnings = []
        with tempfile.TemporaryDirectory() as root, patch.object(run.threading, 'Timer') as timer, contextlib.redirect_stdout(io.StringIO()) as output:
            def complete(_command, **kwargs):
                self.assertEqual(kwargs['timeout'], 3600)
                interval, callback = timer.call_args.args
                self.assertEqual(interval, 2880)
                callback()
                return subprocess.CompletedProcess([], 0)
            with patch.object(run.subprocess, 'run', side_effect=complete):
                run.run_agent(['opencode'], Path(root, 'agent.log'), warnings)
            timer.return_value.cancel.assert_called_once()
        self.assertEqual(warnings, ['agent_time'])
        self.assertIn('warning=agent_time', output.getvalue())

    def test_diagnostics_preserve_500_usage_records(self):
        records = []
        for index in range(500):
            records.extend([{'event': 'api_status', 'outcome': 'success', 'received': index + 1,
                             'attempted': index + 1, 'http_status': 200},
                            gateway.Budget().record(), self.usage()])
        result = subprocess.CompletedProcess([], 0, '\n'.join(map(json.dumps, records)), '')
        with tempfile.TemporaryDirectory() as root, patch.object(run.subprocess, 'run', return_value=result), contextlib.redirect_stdout(io.StringIO()):
            run.report_gateway('gateway', Path(root))
            summary = json.loads(Path(root, 'diagnostics.json').read_text())['summary']
        self.assertEqual(summary['attempted'], 500)
        self.assertEqual(summary['usage_reported'], 500)
        self.assertEqual(summary['usage_unknown'], 0)
        self.assertEqual(summary['prompt_tokens'], 50000)


if __name__ == '__main__':
    unittest.main()
