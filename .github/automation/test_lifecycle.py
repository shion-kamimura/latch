"""Mutable GitHub mock: retry, update, drift and no force-overwrite."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import publish
import run


class GitHubMock:
    def __init__(self):
        self.issue = {'node_id': 'node', 'state': 'open', 'title': 'test', 'body': 'test'}
        self.head = None
        self.prs = []
        self.commits = {}
        self.writes = []
        self.fail_pr = False
        self.race = False

    def api(self, method, path, data=None):
        if method != 'GET':
            self.writes.append((method, path, data))
        if path == '/issues/7':
            return self.issue
        if path.startswith('/pulls?'):
            return self.prs
        if path.startswith('/git/ref/heads/'):
            if self.head is None:
                raise HTTPError(path, 404, 'missing', {}, None)
            return {'object': {'sha': self.head}}
        if path.startswith('/commits/'):
            return self.commits[path.split('/')[-1]]
        if path.startswith('/git/commits/'):
            return {'tree': {'sha': 'base-tree'}}
        if path == '/git/trees':
            return {'sha': 'new-tree'}
        if path == '/git/commits':
            sha = hashlib.sha256(json.dumps(data).encode()).hexdigest()[:40]
            self.commits[sha] = {'committer': {'login': 'github-actions[bot]'},
                                 'commit': {'message': data['message']},
                                 'parents': [{'sha': p} for p in data['parents']]}
            return {'sha': sha}
        if path == '/git/refs' or path.startswith('/git/refs/heads/'):
            if method == 'PATCH':
                assert data['force'] is False
                if self.race:
                    raise HTTPError(path, 422, 'not fast-forward', {}, None)
            self.head = data['sha']
            for pr in self.prs:
                pr['head']['sha'] = self.head
            return {'object': {'sha': self.head}}
        if path == '/pulls':
            if self.fail_pr:
                self.fail_pr = False
                raise HTTPError(path, 503, 'unavailable', {}, None)
            pr = dict(data, state='open', number=8, user={'login': 'github-actions[bot]'},
                      head={'sha': self.head}, html_url='https://example.invalid/8')
            self.prs.append(pr)
            return pr
        if path == '/pulls/8':
            self.prs[0].update(data)
            return self.prs[0]
        raise AssertionError((method, path))


class LifecycleTests(unittest.TestCase):
    def request(self):
        return {'number': 7, 'title': 'test', 'body': 'test', 'node_id': 'node', 'base': 'a' * 40,
                'source': 'a' * 40, 'expected_head': None,
                'branch': 'feat/automated-' + hashlib.sha256(b'node').hexdigest()[:16]}

    def publish(self, github, request, content='first', title='feat: API入力を検証する'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'request.json').write_text(json.dumps(request))
            (root / 'proposal.json').write_text(json.dumps({'files': [{'path': 'src.ts', 'content': content}],
                                                          'checks': dict.fromkeys(run.CHECKS, 0), 'pr_title': title}))
            with patch.dict(os.environ, {'REQUEST_PATH': str(root / 'request.json'), 'OUTPUT_PATH': str(root),
                                         'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_RUN_ID': '123'}), \
                    patch.object(publish, 'api', github.api):
                publish.main()

    def test_create_retry_and_existing_draft_update_are_idempotent(self):
        github, request = GitHubMock(), self.request()
        github.fail_pr = True
        with self.assertRaises(HTTPError):
            self.publish(github, request)
        saved = github.head
        self.publish(github, request)
        self.assertEqual(github.head, saved)
        self.assertEqual(len(github.prs), 1)
        self.publish(github, request)
        self.assertEqual(len(github.prs), 1)
        request.update(source=saved, expected_head=saved)
        self.publish(github, request, 'second', title='fix: API入力の不具合を修正する')
        self.assertEqual(github.prs[0]['title'], 'fix: API入力の不具合を修正する')
        self.assertNotEqual(github.head, saved)
        self.assertEqual(len(github.prs), 1)
        self.assertIn('検証入力commit: ' + saved, github.prs[0]['body'])
        self.assertFalse(any(path == '/git/ref/heads/main' for _, path, _ in github.writes))

    def test_human_tip_and_concurrent_updates_do_not_overwrite(self):
        github, request = GitHubMock(), self.request()
        self.publish(github, request)
        head = github.head
        request.update(source=head, expected_head=head)
        github.commits[head]['committer']['login'] = 'human'
        before = len(github.writes)
        with self.assertRaisesRegex(ValueError, 'Human changes'):
            self.publish(github, request, 'second')
        self.assertEqual(len(github.writes), before)
        github.commits[head]['committer']['login'] = 'github-actions[bot]'
        github.race = True
        with self.assertRaises(HTTPError):
            self.publish(github, request, 'second')
        self.assertEqual(github.head, head)

    def test_requirement_drift_and_closed_issue_keep_snapshot_without_claiming_completion(self):
        for change in [{'title': 'new requirements'}, {'state': 'closed'}]:
            github = GitHubMock()
            github.issue.update(change)
            self.publish(github, self.request())
            self.assertIn('Refs #7', github.prs[0]['body'])
            self.assertNotIn('Closes #7', github.prs[0]['body'])
            self.assertIn('要求スナップショットSHA256', github.prs[0]['body'])


if __name__ == '__main__':
    unittest.main()
