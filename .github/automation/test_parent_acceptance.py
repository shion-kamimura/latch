"""Cross-issue regression with authored API inputs, patches and separate oracle."""
import base64
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import policy
import publish
import run
import test_lifecycle

FIXTURE = Path(__file__).resolve().parents[2] / 'fixtures/ai-development'


class ParentAcceptanceTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node') and shutil.which('git'), 'Node and Git required')
    def test_api_correct_and_buggy_changes_pass_old_tests_but_oracle_distinguishes(self):
        evaluator = '''
import fs from 'node:fs';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
const {handleDuration} = await import(pathToFileURL(process.argv[1]));
const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const item of cases) {
  if (handleDuration(item.url).status !== item.status) process.exitCode = 1;
}
'''
        for name, expected in [('correct', 0), ('buggy', 1)]:
            with self.subTest(patch=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                work = root / 'candidate'
                shutil.copytree(FIXTURE / 'api', work)
                before = run.snapshot(work)
                subprocess.run(['git', 'apply', str(FIXTURE / (name + '.patch'))], cwd=work, check=True, timeout=10)
                subprocess.run(['node', '--test', 'test/existing.test.mjs'], cwd=work,
                               check=True, capture_output=True, timeout=30)
                actual = subprocess.run(['node', '--input-type=module', '-e', evaluator,
                                         str(work / 'src/api.mjs'), str(FIXTURE / 'evaluation/expected.json')],
                                        cwd=work, capture_output=True, timeout=10)
                self.assertEqual(actual.returncode, expected, actual.stderr.decode())
                # Source, manifest, lockfile, YAML and patch data formerly rejected by the allowlist.
                files = run.changes({}, run.snapshot(work))
                files.extend([{'path': 'fixtures/api/' + name + '.patch', 'content': (FIXTURE / (name + '.patch')).read_text()},
                              {'path': '.github/workflows/fixture.yml', 'content': 'name: dummy\n'},
                              {'path': '.env.example', 'content': 'API_KEY=dummy-value'}])
                checks = {key: run.check_result() for key in run.CHECKS + ['dependencies', 'automation']}
                proposal = {'schema_version': 2, 'implementation': 'timeout', 'files': files, 'checks': checks}
                self.assertEqual(publish.validate(proposal), files)
                self.assertNotIn('evaluation', ''.join(item['path'] for item in files))
                self.assertEqual([item['path'] for item in run.changes(before, run.snapshot(work))], ['src/api.mjs'])

    def test_binary_modes_and_links_reach_mock_github_without_text_conversion(self):
        github = test_lifecycle.GitHubMock()
        original_api = github.api
        def api(method, path, data=None):
            if path == '/git/blobs':
                github.writes.append((method, path, data))
                return {'sha': 'binary-blob'}
            return original_api(method, path, data)
        files = [{'path': '画像 fixture.png', 'content': base64.b64encode(b'\x89PNG\x00\xff').decode(),
                  'encoding': 'base64', 'mode': '100644'},
                 {'path': 'script.sh', 'content': '#!/bin/sh\necho test\n', 'mode': '100755'},
                 {'path': 'link', 'content': 'script.sh', 'mode': '120000'}]
        request = test_lifecycle.LifecycleTests().request()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'request.json').write_text(json.dumps(request))
            (root / 'proposal.json').write_text(json.dumps({'files': files, 'checks': dict.fromkeys(run.CHECKS, 0),
                                                          'pr_title': 'test: バイナリとリンクの公開を検証する'}))
            import os
            with patch.dict(os.environ, {'REQUEST_PATH': str(root / 'request.json'), 'OUTPUT_PATH': directory,
                                         'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_RUN_ID': '123'}), patch.object(publish, 'api', api):
                publish.main()
        self.assertEqual(github.prs[0]['title'], 'test: バイナリとリンクの公開を検証する')
        blob = next(data for _, path, data in github.writes if path == '/git/blobs')
        self.assertEqual(base64.b64decode(blob['content']), b'\x89PNG\x00\xff')
        tree = next(data['tree'] for _, path, data in github.writes if path == '/git/trees')
        self.assertEqual([item['mode'] for item in tree], ['100644', '100755', '120000'])
        self.assertEqual(tree[0]['sha'], 'binary-blob')
        self.assertEqual(tree[2]['content'], 'script.sh')

    def test_dummy_key_marker_is_allowed_but_real_key_structure_and_json_credentials_are_rejected(self):
        policy.validate_files([{'path': 'tests/marker.txt', 'content': '-----BEGIN PRIVATE KEY-----'}])
        for data in [json.dumps({'api_key': 's' * 40}),
                     '-----BEGIN PRIVATE KEY-----\n' + 'A' * 80 + '\n-----END PRIVATE KEY-----']:
            with self.assertRaisesRegex(policy.PolicyError, 'secret_detected'):
                policy.validate_files([{'path': 'fixture.json', 'content': data}])
        self.assertFalse(policy.allowed('bad\udcffpath'))

    def test_source_read_log_and_serialized_proposal_resource_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'file').write_bytes(b'x' * 20)
            with patch.object(run, 'MAX_SNAPSHOT_BYTES', 10), self.assertRaisesRegex(policy.PolicyError, 'snapshot_read_limit'):
                run.snapshot(root)
            before = run.snapshot(root)
            (root / 'project.tsbuildinfo').write_text('cache')
            self.assertEqual(run.snapshot(root), before)
            with patch.object(run.resource, 'setrlimit') as limit:
                run.limit_log_output()
                limit.assert_called_once_with(run.resource.RLIMIT_FSIZE, (16 * 1024**2, 16 * 1024**2))
            output = root / 'out'
            output.mkdir()
            with patch.object(run, 'MAX_PROPOSAL_BYTES', 10), self.assertRaisesRegex(policy.PolicyError, 'proposal_too_large'):
                run.save_proposal(output, before, root, run.snapshot(root), [], {}, 'completed')
            self.assertFalse((output / 'proposal.json').exists())


if __name__ == '__main__':
    unittest.main()
