"""Boundary tests; no live keys, Docker daemon, or GitHub writes required."""

import json
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import gateway
import publish
import run


class BoundaryTests(unittest.TestCase):
    def test_api_budget_cannot_be_reset_by_request(self):
        budget = gateway.Budget()
        for _ in range(gateway.MAX_REQUESTS):
            budget.reserve(1)
        with self.assertRaises(ValueError):
            budget.reserve(1)
        budget = gateway.Budget()
        with self.assertRaises(ValueError):
            budget.reserve(gateway.MAX_BYTES + 1)
        with patch.object(gateway, 'MAX_RESERVED', 0):
            budget = gateway.Budget()
            budget.reserve(1)
            self.assertIn('cumulative_bytes', budget.warnings)

    def test_api_pins_model_output_and_removes_client_controls(self):
        data = json.loads(gateway.prepare_request(json.dumps({
            'model': 'deepseek-flash', 'messages': [], 'max_tokens': 999999,
            'stream': True, 'base_url': 'https://attacker.invalid', 'api_key': 'bad',
        })))
        self.assertEqual(data['max_tokens'], gateway.MAX_OUTPUT)
        self.assertFalse(data['stream'])
        self.assertNotIn('base_url', data)
        self.assertNotIn('api_key', data)
        with self.assertRaises(ValueError):
            gateway.prepare_request('{"model":"other"}')

    def test_stream_contains_indexed_tool_call_and_finish(self):
        payload = gateway.stream_response({
            'id': 'test', 'choices': [{'index': 0, 'message': {
                'role': 'assistant', 'content': None,
                'tool_calls': [{'id': 'call', 'type': 'function', 'function': {'name': 'read', 'arguments': '{}'}}],
            }, 'finish_reason': 'tool_calls'}], 'usage': {'total_tokens': 20},
        }).decode()
        events = [json.loads(line[6:]) for line in payload.splitlines() if line.startswith('data: {')]
        self.assertEqual(events[0]['choices'][0]['delta']['tool_calls'][0]['index'], 0)
        self.assertEqual(events[1]['choices'][0]['finish_reason'], 'tool_calls')
        self.assertTrue(payload.endswith('data: [DONE]\n\n'))

    def test_publication_rejects_security_changes_traversal_and_markdown(self):
        for path in ['src/../package.json', '/src/a.ts', 'src\\a.ts', 'docs/a\nb.md']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                publish.validate({'files': [{'path': path, 'content': 'bad'}],
                                  'checks': dict.fromkeys(run.CHECKS, 0)})

    def test_publication_requires_success_and_unique_text_files(self):
        item = {'path': 'src/new.ts', 'content': 'export const value = 1;'}
        valid = {'files': [item], 'checks': dict.fromkeys(run.CHECKS, 0)}
        self.assertEqual(publish.validate(valid), [item])
        for proposal in [dict(valid, checks={}), dict(valid, files=[item, item]),
                         dict(valid, files=[dict(item, content='bad\x00')])]:
            with self.assertRaises(ValueError):
                publish.validate(proposal)

    def test_collects_new_changed_and_deleted_files(self):
        result = run.changes({'src/a.ts': b'old', 'docs/old.md': b'old'},
                             {'src/a.ts': b'new', 'tests/new.ts': b'test'})
        self.assertEqual(result, [
            {'path': 'docs/old.md', 'content': None},
            {'path': 'src/a.ts', 'content': 'new'},
            {'path': 'tests/new.ts', 'content': 'test'},
        ])
        self.assertEqual(run.changes({'package.json': b'original'}, {'package.json': b'changed'})[0]['content'], 'changed')

    def test_snapshot_refuses_symlink_escape(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'src').mkdir()
            (Path(root) / 'src' / 'escape').symlink_to('/etc')
            with self.assertRaises(ValueError):
                run.snapshot(Path(root))

    def test_publisher_stops_without_writes_for_existing_pr_or_changed_main(self):
        for existing in [True, False]:
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as root:
                number, base = 7, 'a' * 40
                branch = 'feat/automated-' + hashlib.sha256(b'issue-node').hexdigest()[:16]
                request = Path(root) / 'issue.json'
                request.write_text(json.dumps({'number': number, 'base': base, 'branch': branch,
                                               'title': 'Example', 'body': 'Requirements'}))
                Path(root, 'proposal.json').write_text(json.dumps({
                    'files': [{'path': 'src/new.ts', 'content': 'example'}],
                    'checks': dict.fromkeys(run.CHECKS, 0),
                }))
                calls = []
                def fake_api(method, path, data=None):
                    calls.append((method, path, data))
                    self.assertEqual(method, 'GET')
                    if path == '/issues/7':
                        return {'state': 'open', 'node_id': 'issue-node',
                                'title': 'Example', 'body': 'Requirements'}
                    if path.startswith('/pulls?'):
                        return [{'number': 8, 'state': 'open', 'draft': False}] if existing else []
                    return {'object': {'sha': 'b' * 40}}
                with patch.dict(os.environ, {'REQUEST_PATH': str(request), 'OUTPUT_PATH': root,
                                             'GITHUB_REPOSITORY': 'owner/repo'}), patch.object(publish, 'api', fake_api):
                    with self.assertRaisesRegex(ValueError, 'branch changed'):
                        publish.main()
                self.assertTrue(all(method == 'GET' for method, _, _ in calls))


if __name__ == '__main__':
    unittest.main()
