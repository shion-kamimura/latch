"""Exercise proposal policy and rejection before any GitHub writes."""

import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import policy
import publish
import run


def request(maintenance=False):
    return {'number': 18, 'title': 'Policy checks', 'body': 'Acceptance criteria',
            'base': 'a' * 40, 'allow_maintenance': maintenance,
            'branch': 'feat/automated-' + hashlib.sha256(b'node').hexdigest()[:16]}


class PolicyTests(unittest.TestCase):
    def test_repository_changes_do_not_require_maintenance_approval(self):
        for path in ['AGENTS.md', 'package.json', 'pnpm-lock.yaml', '.npmrc',
                     '.github/actions/build/action.yml', 'fixtures/api/change.patch',
                     'scripts/日本語 script.sh', '.env.example', 'docs/image.png']:
            for flag in [False, True]:
                self.assertTrue(run.allowed(path, flag))
                self.assertEqual(run.changes({}, {path: b'dummy'}, flag)[0]['path'], path)

    def test_rejects_unsafe_paths(self):
        for path in ['../x', '/x', 'a/../x', 'a//b', '.git/config', 'a/.GIT/x',
                     'C:/x', 'a\\b', 'a\n', 'a\x00']:
            self.assertFalse(run.allowed(path, True), path)

    def test_types_duplicates_and_secret_detection(self):
        for files in [[{'path': 'src/a.ts', 'content': 5}],
                      [{'path': 'docs/a.md', 'content': 'x'}] * 2,
                      [{'path': 'docs/a.md', 'content': 'x', 'mode': '160000'}],
                      [{'path': '.env', 'content': 'API_KEY=' + 'a' * 40}],
                      [{'path': 'key.txt', 'content': '-----BEGIN PRIVATE KEY-----\n' + 'A' * 80 + '\n-----END PRIVATE KEY-----'}]]:
            with self.assertRaises(policy.PolicyError):
                policy.validate_files(files)
        policy.validate_files([{'path': '.env.example', 'content': 'API_KEY=dummy-value'}])
        policy.validate_files([{'path': 'docs/old.md', 'content': None}])

    def test_branch_and_request_validation(self):
        policy.validate_request(request())
        for key, value in [('branch', 'feat/change-18'), ('branch', 'feat/automated-xyz'),
                           ('number', True), ('number', 0), ('base', '../main'),
                           ('allow_maintenance', 'true'), ('title', None)]:
            with self.subTest(key=key), self.assertRaises(policy.PolicyError):
                policy.validate_request(dict(request(), **{key: value}))

    def test_issue_identity_is_fixed_but_requirement_drift_is_reported(self):
        issue = {'node_id': 'node', 'state': 'open', 'title': 'Policy checks', 'body': 'Acceptance criteria'}
        self.assertEqual(policy.validate_issue(request(), issue), 'unchanged')
        for change, expected in [({'state': 'closed'}, 'closed'), ({'title': 'changed'}, 'changed'),
                                  ({'body': ' Acceptance  criteria '}, 'format_only')]:
            self.assertEqual(policy.validate_issue(request(), dict(issue, **change)), expected)
        for change in [{'node_id': 'different'}, {'pull_request': {}}]:
            with self.assertRaises(policy.PolicyError):
                policy.validate_issue(request(), dict(issue, **change))

    def test_pr_sections_and_issue_link(self):
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_RUN_ID': '123'}):
            body = publish.pr_body(request(), [{'path': 'src/a.ts', 'content': 'x'}])
        policy.validate_body(body, 18)
        for section in policy.REQUIRED_SECTIONS:
            policy.validate_body(body.replace('## ' + section, '## renamed'), 18)
        with self.assertRaises(policy.PolicyError):
            policy.validate_body(body.replace('Closes #18', 'Closes #19'), 18)

    def test_report_distinguishes_mechanical_scope_and_human_review(self):
        report = policy.report(request(True), [{'path': 'AGENTS.md', 'content': 'proposal'}])
        self.assertEqual(report['scope_check'], 'repository_boundary_only')
        self.assertIn('semantic_issue_scope', report['human_review_required'])
        self.assertIn('prior_approvals', report['human_review_required'])
        self.assertEqual(report['maintenance_gate'], 'removed')

    def test_maintenance_requires_extra_independent_check(self):
        files = [{'path': '.github/automation/run.py', 'content': 'proposal'}]
        checks = dict.fromkeys(run.CHECKS, 0)
        with self.assertRaises(policy.PolicyError):
            publish.validate({'files': files, 'checks': checks}, True)
        checks[policy.AUTOMATION_CHECK] = 0
        self.assertEqual(publish.validate({'files': files, 'checks': checks}, True), files)
        checks[policy.AUTOMATION_CHECK] = 1
        with self.assertRaises(policy.PolicyError):
            publish.validate({'files': files, 'checks': checks}, True)

    def test_policy_failure_has_only_fixed_diagnostic_label(self):
        error = policy.PolicyError('forbidden_path')
        self.assertEqual(str(error), 'stage=repository_policy error=forbidden_path')
        self.assertEqual(run.failure_reason(error), 'repository_policy_failed')
        with self.assertRaises(policy.PolicyError) as caught:
            run.changes({}, {'../private-data': b'private-data\xff'})
        self.assertNotIn('private-data', str(caught.exception))

    def test_invalid_body_or_changed_issue_stops_before_any_write(self):
        for changed_issue in [False, True]:
            with self.subTest(changed_issue=changed_issue), tempfile.TemporaryDirectory() as root:
                Path(root, 'issue.json').write_text(json.dumps(request()))
                Path(root, 'proposal.json').write_text(json.dumps({
                    'pr_title': 'feat: 要求と変更可能範囲を検査する',
                    'files': [{'path': 'src/a.ts', 'content': 'x'}],
                    'checks': dict.fromkeys(run.CHECKS, 0), 'pr_title': 'feat: APIの動作を実装する'}))
                def api(method, path, data=None):
                    self.assertEqual(method, 'GET', 'Policy must run before the first GitHub write')
                    if path.startswith('/issues/'):
                        return {'node_id': 'node', 'state': 'open', 'title': 'Policy checks',
                                'body': 'changed' if changed_issue else 'Acceptance criteria'}
                    if path.startswith('/pulls?'):
                        return []
                    from urllib.error import HTTPError
                    raise HTTPError(path, 404, 'not found', {}, None)
                with patch.dict(os.environ, {'REQUEST_PATH': root + '/issue.json', 'OUTPUT_PATH': root,
                                             'GITHUB_REPOSITORY': 'owner/repo'}), \
                        patch.object(publish, 'api', api), patch.object(publish, 'pr_body', return_value='invalid'):
                    with self.assertRaises(policy.PolicyError):
                        publish.main()

    def test_maintenance_proposal_creates_only_a_draft_after_checks(self):
        with tempfile.TemporaryDirectory() as root:
            data = request(True)
            Path(root, 'issue.json').write_text(json.dumps(data))
            Path(root, 'proposal.json').write_text(json.dumps({
                'pr_title': 'docs: 開発ルールを明文化する',
                'files': [{'path': 'AGENTS.md', 'content': 'Reviewed proposal'}],
                'checks': dict.fromkeys(run.CHECKS + [policy.AUTOMATION_CHECK], 0), 'pr_title': 'docs: 開発ルールを更新する'}))
            writes = []
            def api(method, path, body=None):
                if method == 'GET':
                    if path.startswith('/issues/'):
                        return {'node_id': 'node', 'state': 'open', 'title': data['title'], 'body': data['body']}
                    if path.startswith('/pulls?'):
                        return []
                    if path == '/git/ref/heads/' + data['branch'] and any(p == '/git/refs' for p, _ in writes):
                        return {'object': {'sha': 'c' * 40}}
                    if path == '/git/commits/' + data['base']:
                        return {'tree': {'sha': 'b' * 40}}
                    from urllib.error import HTTPError
                    raise HTTPError(path, 404, 'not found', {}, None)
                writes.append((path, body))
                if path == '/pulls':
                    self.assertTrue(body['draft'])
                    self.assertEqual(body['base'], 'main')
                    policy.validate_body(body['body'], 18)
                    self.assertIn('未検証', body['body'])
                    return {'html_url': 'https://example.invalid/draft'}
                return {'sha': 'c' * 40}
            with patch.dict(os.environ, {'REQUEST_PATH': root + '/issue.json', 'OUTPUT_PATH': root,
                                         'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_RUN_ID': '123'}), \
                    patch.object(publish, 'api', api):
                publish.main()
            self.assertEqual([path for path, _ in writes],
                             ['/git/trees', '/git/commits', '/git/refs', '/pulls'])
            self.assertEqual(writes[0][1]['tree'][0]['mode'], '100644')
            self.assertEqual(writes[2][1]['ref'], 'refs/heads/' + data['branch'])

    def test_prompt_includes_rules_acceptance_and_stop_condition(self):
        prompt = run.agent_prompt(request())
        self.assertIn('acceptance criteria', prompt)
        self.assertIn('Preserve safe partial work on failure', prompt)
        self.assertIn('documents relevant to the implementation', prompt)
        self.assertEqual(prompt, run.agent_prompt(request(True)))

    def test_candidate_automation_only_executes_in_isolated_container(self):
        command = run.automation_command('/candidate', '/base', 'isolated-policy-check')
        self.assertIn('none', command)
        self.assertIn('--read-only', command)
        self.assertIn('type=bind,src=/base,dst=/trusted,readonly', command)
        self.assertIn('type=bind,src=/candidate,dst=/work,readonly', command)
        self.assertIn('PYTHONPATH=/work/.github/automation', command)
        self.assertIn('cp /trusted/test_*.py /tmp/base-tests/', command[-1])
        self.assertFalse(any('KEY' in arg or 'TOKEN' in arg for arg in command))


if __name__ == '__main__':
    unittest.main()
