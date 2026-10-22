"""Measured token reservation, missing charges, and trusted settings."""
from decimal import Decimal
import hashlib
import io
import json
import socket
import unittest
from unittest.mock import Mock, patch
import urllib.error

import gateway
import run
import test_diagnostics


class CostLimitsTests(unittest.TestCase):
    def test_old_cumulative_limit_is_warning_while_cost_and_time_still_bound(self):
        budget = gateway.Budget()
        for _ in range(300):
            amount = budget.authorize(1024 * 1024, prompt_tokens=100)
            budget.settle(gateway.usage_record({'usage': {'prompt_tokens': 100, 'completion_tokens': 1}}, 1), amount)
        self.assertGreater(budget.reserved, gateway.MAX_RESERVED)
        self.assertIn('cumulative_bytes', budget.warnings)
        self.assertLess(budget.estimated, Decimal('5'))
        self.assertEqual(run.AGENT_TIMEOUT, 3600)
        self.assertEqual(budget.settings['requests'], 10000)

    def test_small_measured_requests_survive_unknown_usage_without_context_sized_holds(self):
        old, new = gateway.Budget(), gateway.Budget()
        old_completed = new_completed = 0
        for _ in range(100):
            try:
                old.authorize(100)
                old_completed += 1
            except gateway.Rejected:
                pass
            new.authorize(100, prompt_tokens=20)
            new_completed += 1
        self.assertEqual(old_completed, 16)
        self.assertEqual(new_completed, 100)
        self.assertGreater(new.held, 0)  # Unknown charges were never zeroed.
        self.assertLess(new.held, new.pricing['limit_usd'])
        self.assertEqual(new.record()['count_basis'], 'tokenizer')

    def test_identical_payload_reuses_observed_prompt_count_not_bytes_conversion(self):
        budget = gateway.Budget()
        fingerprint = hashlib.sha256(b'exact model/messages/tools/config').hexdigest()
        first = budget.authorize(1, fingerprint=fingerprint)
        budget.settle(gateway.usage_record({'usage': {'prompt_tokens': 20, 'completion_tokens': 1}}, 1), first, fingerprint)
        second = budget.authorize(1, fingerprint=fingerprint)
        self.assertLess(second, first)
        self.assertEqual(budget.record()['count_basis'], 'identical_request_usage')
        unmatched = budget.authorize(1, fingerprint='different')
        self.assertEqual(unmatched, first)
        self.assertEqual(budget.record()['count_basis'], 'model_context_fallback')

    def test_template_counts_protocol_tools_and_generation_prefix(self):
        counter = gateway.PromptCounter()
        counter.tokenizer = Mock()
        counter.tokenizer.apply_chat_template.return_value = list(range(37))
        payload = json.loads(gateway.prepare_request(json.dumps({'model': gateway.MODEL,
                             'messages': [{'role': 'user', 'content': 'test'}], 'tools': [{'type': 'function'}]})))
        self.assertEqual(counter.count(payload), 37)
        args = counter.tokenizer.apply_chat_template.call_args
        self.assertEqual(args.kwargs['tools'], payload['tools'])
        self.assertTrue(args.kwargs['add_generation_prompt'])
        counter.tokenizer.apply_chat_template.side_effect = ValueError('unsupported template')
        self.assertIsNone(counter.count(payload))
        self.assertIsNone(gateway.PromptCounter().count(payload))

    def test_usage_disagreement_reconciles_and_stops_instead_of_silent_overspend(self):
        budget = gateway.Budget()
        amount = budget.authorize(10, prompt_tokens=1)
        budget.settle(gateway.usage_record({'usage': {'prompt_tokens': 20, 'completion_tokens': 1}}, 1), amount)
        self.assertTrue(budget.stopped)
        self.assertEqual(budget.held, 0)
        self.assertGreater(budget.estimated, 0)
        with self.assertRaisesRegex(gateway.Rejected, 'cost_limit'):
            budget.authorize(1)

    def test_known_rejection_and_non_send_release_while_ambiguous_timeouts_hold(self):
        helper = test_diagnostics.DiagnosticsTests()
        for error, held in [(urllib.error.HTTPError('https://upstream', 401, 'hidden', {}, None), False),
                             (urllib.error.HTTPError('https://upstream', 429, 'hidden', {}, None), False),
                             (urllib.error.URLError(socket.gaierror('dns failed')), False),
                             (urllib.error.URLError(ConnectionRefusedError()), False),
                             (urllib.error.HTTPError('https://upstream', 500, 'hidden', {}, None), True),
                             (TimeoutError(), True)]:
            _, handler, _ = helper.request(error)
            self.assertEqual(handler.budget.held > 0, held)
            self.assertEqual(handler.budget.estimated, 0)

    def test_trusted_model_settings_and_candidate_controls(self):
        settings = dict(gateway.DEFAULT_MODEL_CONFIG, output_tokens=1024, thinking='enabled', requests=2000)
        prepared = json.loads(gateway.prepare_request(json.dumps({'model': gateway.MODEL, 'messages': [],
                              'max_tokens': 999999, 'thinking': {'type': 'disabled'}, 'limit_usd': 999}), settings))
        self.assertEqual(prepared['max_tokens'], 1024)
        self.assertEqual(prepared['thinking']['type'], 'enabled')
        self.assertNotIn('limit_usd', prepared)
        config = json.loads(run.agent_config('gateway', settings))
        self.assertEqual(config['provider']['deepseek']['models'][gateway.MODEL]['limit']['output'], 1024)
        for change in [{'model': 'arbitrary'}, {'output_tokens': 999999}, {'requests': 0},
                       {'context_tokens': gateway.MAX_CONTEXT + 1}, {'thinking': 'anything'}, {'endpoint': 'attacker'}]:
            with self.assertRaises(ValueError):
                gateway.model_config(json.dumps(dict(settings, **change)))


if __name__ == '__main__':
    unittest.main()
