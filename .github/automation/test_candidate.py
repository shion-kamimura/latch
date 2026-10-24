"""Saved-candidate identity, recovery, and read-only verification integration."""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

import candidate
from policy import PolicyError
import publish
import resume
import run
import test_lifecycle
import verify

IMAGE = 'sha256:' + '1' * 64


def bundle_for(root, request=None):
    request = request or test_lifecycle.LifecycleTests().request()
    source, target = root / 'source', root / 'target'
    source.mkdir()
    target.mkdir()
    (source / 'package.json').write_text('{"scripts":{"test":"vitest run --project unit --project integration && pnpm build && vitest run --project e2e"}}')
    (target / 'package.json').write_bytes((source / 'package.json').read_bytes())
    (target / 'new.ts').write_text('export {};')
    files = run.changes(run.snapshot(source), run.snapshot(target))
    output = root / 'saved'
    output.mkdir()
    with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}), \
            patch.object(subprocess, 'check_output', return_value=IMAGE):
        return candidate.save_bundle(output, request, files, 'completed', 'feat: API入力を検証する', run.snapshot(target))


def proposal_for(bundle, attempt='1'):
    m = bundle['manifest']
    v = {key: m[key] for key in ['candidate_digest', 'request_digest', 'snapshot_digest', 'base', 'source', 'control_digest']}
    v.update(run_id='456', attempt=attempt, image=IMAGE)
    return dict(bundle['candidate'], schema_version=3, candidate_manifest=m, validation=v,
                checks={key: run.check_result('passed', 0, 'exit_code') for key in [*run.CHECKS, 'dependencies']})


class CandidateTests(unittest.TestCase):
    def test_digest_covers_files_modes_deletions_request_and_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = bundle_for(Path(directory))
            def validate(value):
                candidate.validate_bundle(value, 'owner/repo', '123', '1', 'a' * 40)
            validate(bundle)
            mutations = [lambda b: b['candidate']['files'][0].update(content='different'),
                         lambda b: b['candidate']['files'][0].update(mode='100755'),
                         lambda b: b['candidate']['files'][0].update(content=None),
                         lambda b: b['request'].update(body='changed'),
                         lambda b: b['request'].update(source='b' * 40),
                         lambda b: b['manifest'].update(repository='foreign/repo'),
                         lambda b: b['manifest'].update(origin_run='124'),
                         lambda b: b['manifest'].update(origin_attempt='2'),
                         lambda b: b['manifest'].update(base='c' * 40),
                         lambda b: b['manifest'].update(expires_at=int(time.time()) - 1)]
            for mutate in mutations:
                altered = copy.deepcopy(bundle)
                mutate(altered)
                with self.assertRaises(PolicyError):
                    validate(altered)
            with self.assertRaisesRegex(PolicyError, 'candidate_expired'):
                candidate.validate_bundle(bundle, 'owner/repo', '123', '1', 'a' * 40,
                                          now=bundle['manifest']['expires_at'])

    def test_materialization_preserves_binary_modes_links_deletions_and_refuses_link_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, work = root / 'source', root / 'work'
            source.mkdir()
            work.mkdir()
            (source / 'removed').write_text('old')
            files = [{'path': 'removed', 'content': None}, {'path': 'script', 'content': 'test', 'mode': '100755'},
                     {'path': 'binary', 'content': base64.b64encode(b'\xff\x00').decode(), 'encoding': 'base64'},
                     {'path': 'link', 'content': 'script', 'mode': '120000'}]
            before, after = verify.materialize(source, work, files)
            self.assertNotIn('removed', after)
            self.assertEqual((work / 'binary').read_bytes(), b'\xff\x00')
            self.assertEqual(after['script'].mode, '100755')
            self.assertTrue((work / 'link').is_symlink())
            self.assertIn('removed', before)
            with self.assertRaisesRegex(PolicyError, 'candidate_path_collision'):
                verify.materialize(source, root, files + [{'path': 'link/evil', 'content': 'bad'}])

    def test_verification_failure_then_retry_same_candidate_without_agent_or_api(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = bundle_for(root)
            bundle_path = root / 'saved/candidate.json'
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w') as tar:
                tar.add(root / 'source/package.json', arcname='package.json')
            for dependency_failure in [True, False]:
                output = root / ('failure' if dependency_failure else 'retry')
                env = {'BUNDLE_PATH': str(bundle_path), 'CANDIDATE_PATH': str(root), 'OUTPUT_PATH': str(output),
                       'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_RUN_ID': '456', 'GITHUB_RUN_ATTEMPT': '1',
                       'ORIGIN_RUN_ID': '123', 'ORIGIN_ATTEMPT': '1'}
                def command(args, **kwargs):
                    if args[:3] == ['git', 'rev-parse', 'HEAD']:
                        return 'a' * 40
                    if args[0] == 'git':
                        return archive.getvalue()
                    return IMAGE
                with patch.dict(os.environ, env, clear=True), patch.object(subprocess, 'check_output', side_effect=command), \
                        patch.object(run, 'execute'), patch.object(run.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)), \
                        patch.object(run, 'stop_container'), patch.object(run, 'run_agent') as agent, \
                        patch.object(run, 'report_gateway') as gateway, patch.object(run, 'prepare_dependencies',
                            side_effect=ValueError('stage=dependencies error=dependency_fetch_failed') if dependency_failure else None), \
                        patch.object(run, 'independent_check', return_value=run.check_result('passed', 0, 'exit_code')) as check:
                    if dependency_failure:
                        with self.assertRaisesRegex(ValueError, 'partial_results'):
                            verify.main()
                    else:
                        verify.main()
                    agent.assert_not_called()
                    gateway.assert_not_called()
                    # build is already covered by the fixed test script on success.
                    self.assertEqual(check.call_count, 0 if dependency_failure else 4)
                proposal = json.loads((output / 'proposal.json').read_text())
                self.assertEqual(proposal['candidate_manifest'], bundle['manifest'])
                self.assertEqual(proposal['files'], bundle['candidate']['files'])
                self.assertEqual(proposal['checks']['test']['status'], 'not_run' if dependency_failure else 'passed')
                candidate.validate_proposal(proposal, bundle['request'], 'owner/repo', '456', '1')
                if not dependency_failure:
                    self.assertEqual(proposal['checks']['build']['reason'], 'covered_by_test')

    def test_foreign_or_old_source_and_policy_results_never_bind(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = bundle_for(root)
            value = proposal_for(bundle)
            candidate.validate_proposal(value, bundle['request'], 'owner/repo', '456', '1')
            for key in ['candidate_digest', 'request_digest', 'snapshot_digest', 'source', 'base', 'control_digest', 'run_id', 'attempt']:
                bad = copy.deepcopy(value)
                bad['validation'][key] = 'different'
                with self.assertRaises(PolicyError):
                    candidate.validate_proposal(bad, bundle['request'], 'owner/repo', '456', '1')
            bad = copy.deepcopy(value)
            bad['candidate_manifest']['control_digest'] = 'f' * 64
            with self.assertRaisesRegex(PolicyError, 'verification_policy_mismatch'):
                candidate.validate_proposal(bad, bundle['request'], 'owner/repo', '456', '1')
            # Even a rehashed, syntactically valid different source cannot reconstruct the snapshot.
            wrong = copy.deepcopy(bundle)
            wrong['manifest']['snapshot_digest'] = 'f' * 64
            (root / 'saved/candidate.json').write_text(json.dumps(wrong))
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w') as tar:
                tar.add(root / 'source/package.json', arcname='package.json')
            env = {'BUNDLE_PATH': str(root / 'saved/candidate.json'), 'CANDIDATE_PATH': str(root),
                   'OUTPUT_PATH': str(root / 'out'), 'GITHUB_REPOSITORY': 'owner/repo',
                   'ORIGIN_RUN_ID': '123', 'ORIGIN_ATTEMPT': '1'}
            with patch.dict(os.environ, env), patch.object(subprocess, 'check_output', side_effect=['a' * 40, archive.getvalue()]), \
                    patch.object(run, 'execute') as execute, self.assertRaisesRegex(PolicyError, 'candidate_source_mismatch'):
                verify.main()
            execute.assert_not_called()
            self.assertFalse((root / 'out/proposal.json').exists())

    def test_reverification_updates_evidence_without_new_commit_and_preserves_human_head(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = bundle_for(root)
            github = test_lifecycle.GitHubMock()
            (root / 'request.json').write_text(json.dumps(bundle['request']))
            env = {'REQUEST_PATH': str(root / 'request.json'), 'OUTPUT_PATH': str(root),
                   'BUNDLE_PATH': str(root / 'saved/candidate.json'), 'GITHUB_REPOSITORY': 'owner/repo',
                   'GITHUB_RUN_ID': '456', 'GITHUB_RUN_ATTEMPT': '1'}
            def publish_attempt(attempt, failed=False):
                value = proposal_for(bundle, attempt)
                if failed:
                    value['checks']['test'] = run.check_result('failed', 1, 'exit_code')
                (root / 'proposal.json').write_text(json.dumps(value))
                with patch.dict(os.environ, dict(env, GITHUB_RUN_ATTEMPT=attempt)), patch.object(publish, 'api', github.api):
                    publish.main()
            publish_attempt('1', failed=True)
            head = github.head
            self.assertIn('test: failed', github.prs[0]['body'])
            publish_attempt('2')
            self.assertEqual(github.head, head)
            self.assertEqual(len([w for w in github.writes if w[1] == '/git/commits']), 1)
            self.assertIn('検証run/attempt: 456/2', github.prs[0]['body'])
            self.assertIn('候補SHA256: ' + bundle['manifest']['candidate_digest'], github.prs[0]['body'])
            self.assertIn('公開対象commit: ' + head, github.prs[0]['body'])
            # A publish-only rerun retains the successful verification attempt.
            with patch.dict(os.environ, dict(env, GITHUB_RUN_ATTEMPT='3', VALIDATION_ATTEMPT='2')), patch.object(publish, 'api', github.api):
                publish.main()
            self.assertEqual(github.head, head)
            self.assertIn('検証run/attempt: 456/2', github.prs[0]['body'])
            different = proposal_for(bundle, '3')
            different['files'] = [{'path': 'new.ts', 'content': 'different'}]
            different['candidate_manifest'] = dict(bundle['manifest'], candidate_digest=candidate.digest(
                {key: different[key] for key in ['files', 'implementation', 'pr_title']}))
            different['validation']['candidate_digest'] = different['candidate_manifest']['candidate_digest']
            (root / 'proposal.json').write_text(json.dumps(different))
            writes = len(github.writes)
            with patch.dict(os.environ, dict(env, GITHUB_RUN_ATTEMPT='3')), patch.object(publish, 'api', github.api), \
                    self.assertRaisesRegex(PolicyError, 'candidate_identity_mismatch'):
                publish.main()
            self.assertEqual(len(github.writes), writes)
            github.head = 'd' * 40
            github.commits[github.head] = {'committer': {'login': 'human'}, 'commit': {'message': 'human'}}
            writes = len(github.writes)
            with self.assertRaisesRegex(ValueError, 'branch changed'):
                publish_attempt('3')
            self.assertEqual(len(github.writes), writes)


class ArtifactTests(unittest.TestCase):
    def test_main_run_repository_workflow_and_permissions_are_required(self):
        env = {'GITHUB_REF': 'refs/heads/main', 'GITHUB_ACTOR': 'owner', 'GITHUB_TRIGGERING_ACTOR': 'owner',
               'ORIGIN_RUN_ID': '123', 'ORIGIN_ATTEMPT': '1', 'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_REPOSITORY_ID': '42'}
        run_data = {'id': 123, 'repository': {'id': 42, 'full_name': 'owner/repo'}, 'head_repository': {'id': 42},
                    'event': 'workflow_dispatch', 'head_branch': 'main', 'path': '.github/workflows/issue-draft-pr.yml',
                    'head_sha': 'a' * 40, 'run_attempt': 2}
        def inspect(data, permission='write'):
            with patch.dict(os.environ, env), patch.object(resume, 'api', side_effect=lambda m, p: {'permission': permission} if '/collaborators/' in p else data):
                return resume.inspect_origin()
        self.assertEqual(inspect(run_data), run_data)
        for key, value in [('head_branch', 'feature'), ('event', 'pull_request'), ('path', '.github/workflows/other.yml'),
                           ('repository', {'id': 43, 'full_name': 'foreign/repo'}), ('head_repository', {'id': 43}), ('run_attempt', 0)]:
            bad = dict(run_data, **{key: value})
            with self.assertRaises(PolicyError):
                inspect(bad)
        with self.assertRaisesRegex(PolicyError, 'write_permission_required'):
            inspect(run_data, 'read')
        env['GITHUB_REF'] = 'refs/heads/feature'
        with self.assertRaisesRegex(PolicyError, 'main_required'):
            inspect(run_data)

    def test_expired_missing_duplicate_and_digestless_artifacts_are_refused(self):
        artifact = {'id': 10, 'name': 'issue-candidate-123-1', 'expired': False, 'expires_at': '2099-01-01T00:00:00Z',
                    'created_at': '2026-10-24T00:00:00Z', 'size_in_bytes': 100, 'digest': 'sha256:' + 'a' * 64}
        now = resume.timestamp(artifact['created_at']) + 60
        def find(items):
            with patch.object(resume, 'api', return_value={'artifacts': items}), patch.object(resume.time, 'time', return_value=now):
                return resume.find_artifact('123', '1')
        self.assertEqual(find([artifact]), artifact)
        for items in [[], [artifact, artifact], [dict(artifact, expired=True)], [dict(artifact, digest=None)],
                      [dict(artifact, created_at='2026-10-22T00:00:00Z')]]:
            with self.assertRaises(PolicyError):
                find(items)

    def test_archive_is_allowlisted_bounded_and_authenticated_by_api_digest(self):
        def archive(name, value):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as z:
                z.writestr(name, value)
            return stream.getvalue()
        raw = archive('candidate.json', '{"data":"test"}')
        self.assertEqual(resume.decode_archive(raw), {'data': 'test'})
        for name in ['../candidate.json', 'folder/candidate.json', 'evil.py']:
            with self.assertRaisesRegex(PolicyError, 'invalid_artifact_archive'):
                resume.decode_archive(archive(name, '{}'))
        metadata = {'id': 10, 'digest': 'sha256:' + hashlib.sha256(raw).hexdigest(), 'size_in_bytes': len(raw)}
        def download(meta):
            response = io.BytesIO(raw)
            opener = unittest.mock.Mock()
            opener.open.return_value = response
            with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'owner/repo', 'GH_TOKEN': 'dummy'}), \
                    patch.object(resume.urllib.request, 'build_opener', return_value=opener):
                return resume.download_archive(meta)
        self.assertEqual(download(metadata), raw)
        with self.assertRaisesRegex(PolicyError, 'artifact_digest_mismatch'):
            download(dict(metadata, digest='sha256:' + '0' * 64))

class ImplementationSeparationTests(unittest.TestCase):
    def test_implementation_saves_before_any_independent_dependency_preparation(self):
        for agent_error in [False, True]:
            with self.subTest(agent_error=agent_error), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                request = test_lifecycle.LifecycleTests().request()
                (root / 'issue.json').write_text(json.dumps(request))
                archive = io.BytesIO()
                with tarfile.open(fileobj=archive, mode='w') as tar:
                    data = b'{"scripts":{"test":"test"}}'
                    entry = tarfile.TarInfo('package.json')
                    entry.size = len(data)
                    tar.addfile(entry, io.BytesIO(data))
                def agent(args, *unused):
                    mount = next(arg for arg in args if arg.startswith('type=bind,src=') and arg.endswith('dst=/work'))
                    work = Path(mount.split('src=')[1].split(',')[0])
                    (work / 'new.ts').write_text('export {};')
                    (work / 'dist').mkdir()
                    (work / 'dist/latch-pr-title.json').write_text('{"title":"feat: 保存候補を作成する"}')
                    if agent_error:
                        raise ValueError('stage=opencode_run error=timeout')
                env = {'DEEPSEEK_API_KEY': 'dummy', 'LATCH_IMPLEMENT_ONLY': '1', 'REQUEST_PATH': str(root / 'issue.json'),
                       'OUTPUT_PATH': str(root / 'out'), 'GITHUB_REPOSITORY': 'owner/repo',
                       'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
                def command(args, **unused):
                    return archive.getvalue() if args[0] == 'git' else IMAGE
                with patch.dict(os.environ, env), patch.object(subprocess, 'check_output', side_effect=command), \
                        patch.object(run, 'execute'), patch.object(run, 'verify_startup'), \
                        patch.object(run.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)), \
                        patch.object(run, 'run_agent', side_effect=agent), patch.object(run, 'stop_container'), \
                        patch.object(run, 'report_gateway'), patch.object(run, 'prepare_dependencies') as dependencies, \
                        patch.object(run, 'independent_check') as check:
                    if agent_error:
                        with self.assertRaises(ValueError):
                            run.main()
                    else:
                        run.main()
                    dependencies.assert_not_called()
                    check.assert_not_called()
                bundle = candidate.read_json(root / 'out/candidate.json')
                self.assertEqual(bundle['candidate']['implementation'], 'timeout' if agent_error else 'completed')
                self.assertFalse((root / 'out/proposal.json').exists())
                candidate.validate_bundle(bundle, 'owner/repo', '123', '1', 'a' * 40)


if __name__ == '__main__':
    unittest.main()
