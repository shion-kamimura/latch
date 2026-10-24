"""Real disposable-container retry; no GitHub writes or model API are used."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

import candidate
import run
import verify


def main():
    base = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / 'source'
        source.mkdir()
        package = {'name': 'saved-candidate-fixture', 'version': '1.0.0', 'private': True, 'packageManager': 'pnpm@12.14.0',
                   'scripts': {key: 'node check.cjs' for key in run.CHECKS}}
        (source / 'package.json').write_text(json.dumps(package))
        (source / '.npmrc').write_text('manage-package-manager-versions=false\n')
        (source / 'value.cjs').write_text('module.exports = 1;\n')
        (source / 'check.cjs').write_text("require('node:assert/strict').equal(require('./value.cjs'), 2);\n")
        # Prepare only lock data inside a network-free, credential-free container.
        subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop=ALL',
                        '--security-opt=no-new-privileges', '--user', f'{os.getuid()}:{os.getgid()}',
                        '--tmpfs', '/tmp:rw,nosuid,size=128m', *run.RUNTIME_ENV,
                        '--mount', f'type=bind,src={source},dst=/work', '-w', '/work',
                        'latch-agent', *run.PNPM, 'install', '--lockfile-only', '--offline', '--ignore-scripts'], check=True)
        for args in [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                     'commit', '-qm', 'fixture']]:
            subprocess.run(['git', '-C', str(source), *args], check=True)
        source_sha = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        before = run.snapshot(source)
        (source / 'value.cjs').write_text('module.exports = 2;\n')
        generated = run.snapshot(source)
        files = run.changes(before, generated)
        request = {'number': 56, 'node_id': 'fixture', 'title': 'fixture', 'body': 'fixture', 'base': base,
                   'source': source_sha, 'expected_head': None, 'branch': 'feat/automated-' + 'a' * 16}
        saved = root / 'saved'
        saved.mkdir()
        # Fixed local identities are deliberately not downloadable GitHub provenance.
        origin = {'GITHUB_REPOSITORY': 'fixture/local', 'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}
        with patch.dict(os.environ, origin):
            bundle = candidate.save_bundle(saved, request, files, 'completed', 'test: 保存候補を再検証する', generated)
        env = dict(origin, BUNDLE_PATH=str(saved / 'candidate.json'), CANDIDATE_PATH=str(source),
                   ORIGIN_RUN_ID='1', ORIGIN_ATTEMPT='1', GITHUB_RUN_ID='2')
        with patch.dict(os.environ, dict(env, OUTPUT_PATH=str(root / 'failed'))), \
                patch.object(run, 'prepare_dependencies', side_effect=ValueError('stage=dependencies error=dependency_fetch_failed')):
            try:
                verify.main()
            except ValueError as error:
                if str(error) != 'partial_results':
                    raise
            else:
                raise AssertionError('The injected environment failure must remain a failure')
        with patch.dict(os.environ, dict(env, OUTPUT_PATH=str(root / 'passed'))), \
                patch.object(run, 'run_agent', side_effect=AssertionError('AI must not run')), \
                patch.object(run, 'report_gateway', side_effect=AssertionError('Gateway must not run')):
            verify.main()
        failed = candidate.read_json(root / 'failed/proposal.json')
        passed = candidate.read_json(root / 'passed/proposal.json')
        assert failed['checks']['dependencies']['status'] == 'environment_unavailable'
        assert failed['checks']['test']['status'] == 'not_run'
        assert all(item['status'] == 'passed' for item in passed['checks'].values())
        assert passed['candidate_manifest'] == failed['candidate_manifest'] == bundle['manifest']
        candidate.validate_proposal(passed, request, 'fixture/local', '2', '1')
        print('Saved candidate retry passed in real containers; injected preparation failure recovered, model API calls=0.')


if __name__ == '__main__':
    main()
