"""Only trusted code runs in this job. Treat the proposal as hostile data."""

import json
import os
from pathlib import Path
import urllib.error
import urllib.request

from run import CHECKS
from policy import AUTOMATION_CHECK, PolicyError, report, validate_files, validate_issue, validate_request, maintenance_path, MAX_PROPOSAL_BYTES


def validate(proposal, maintenance=False):
    files, checks = proposal['files'], proposal['checks']
    validate_files(files, maintenance)
    if not files:
        return []
    expected_names = CHECKS + ([AUTOMATION_CHECK] if any(maintenance_path(item['path']) for item in files) else [])
    if proposal.get('schema_version') == 2:
        if (set(checks) != set(expected_names + ['dependencies'])
                or proposal.get('implementation') not in {'completed', 'timeout', 'api_error', 'startup_error',
                   'abnormal_exit', 'agent_error', 'configuration_error', 'model_configuration_error',
                   'provider_initialization_error', 'host_io_error'}):
            raise PolicyError('invalid_results')
        for result in checks.values():
            if (not isinstance(result, dict) or set(result) != {'status', 'exit_code', 'reason'}
                    or result['status'] not in {'passed', 'failed', 'timeout', 'not_run', 'environment_unavailable'}
                    or result['reason'] not in {'not_started', 'exit_code', 'time_limit', 'host_io_error',
                       'covered_by_test', 'dependency_mismatch', 'registry_denied', 'dependency_fetch_failed',
                       'install_script_failed', 'validation_timeout', 'host_validation_failed'}):
                raise PolicyError('invalid_results')
            code = result['exit_code']
            if result['status'] in {'passed', 'failed'}:
                if type(code) is not int or not -255 <= code <= 255 or (result['status'] == 'passed') != (code == 0):
                    raise PolicyError('invalid_results')
            elif code is not None:
                raise PolicyError('invalid_results')
    else:
        expected = dict.fromkeys(expected_names, 0)
        if checks != expected or any(type(value) is not int for value in checks.values()):
            raise PolicyError('independent_checks_failed')
    return files


def api(method, path, data=None):
    request = urllib.request.Request(
        'https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + path,
        method=method, data=None if data is None else json.dumps(data).encode(),
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
                 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def pr_body(request, files, proposal=None):
    number = request['number']
    run_url = 'https://github.com/' + os.environ['GITHUB_REPOSITORY'] + '/actions/runs/' + os.environ['GITHUB_RUN_ID']
    checks = proposal.get('checks', {}) if proposal else dict.fromkeys(CHECKS, 0)
    implementation = (proposal or {}).get('implementation', 'completed')
    results = []
    for name, value in checks.items():
        if isinstance(value, dict):
            results.append('- ' + name + ': ' + value['status'] + ' / ' + value['reason'] +
                           (' / exit=' + str(value['exit_code']) if value['exit_code'] is not None else ''))
        else:
            results.append('- ' + name + ': passed / exit=0')
    return (f'## 変更概要\n\nIssue #{number} に対する提案。実装状態: {implementation}。未完了成果を含み得ます。\n\n'
            f'## 関連Issue\n\nCloses #{number}\n\n## 実装内容\n\n'
            + '\n'.join('- ' + json.dumps(item['path'], ensure_ascii=True) for item in files)
            + '\n\n## 検証結果\n\n' + '\n'.join(results)
            + '\n\n## 未検証事項\n\n実行済みの成功・失敗・未実行は上記の通りです。'
            + 'Issueとの意味的整合、受け入れ条件全体、生成テストの妥当性、実サービス接続は未検証です。'
            + '候補の安全性・ワークフロー権限は人間がレビューしてください。変更前の信頼した制御を使用しました。'
            + f'\n\n[実行ログ]({run_url})。GITHUB_TOKENによるPRは通常CIを自動起動しません。')


def main():
    request = json.loads(Path(os.environ['REQUEST_PATH']).read_text())
    proposal_path = Path(os.environ['OUTPUT_PATH']) / 'proposal.json'
    if proposal_path.is_symlink() or proposal_path.stat().st_size > MAX_PROPOSAL_BYTES:
        raise ValueError('Invalid proposal size/type')
    proposal = json.loads(proposal_path.read_text())
    validate_request(request)
    files = validate(proposal, request.get('allow_maintenance', False))
    if not files:
        print('No changes; no PR created.')
        return
    base, branch, number = request['base'], request['branch'], request['number']
    issue = api('GET', f'/issues/{number}')
    validate_issue(request, issue)
    owner = os.environ['GITHUB_REPOSITORY'].split('/')[0]
    existing = api('GET', f'/pulls?state=all&head={owner}:{branch}&per_page=100')
    if existing:
        print('PR already exists; no duplicate created.')
        return
    if api('GET', '/git/ref/heads/main')['object']['sha'] != base:
        raise ValueError('main changed during implementation; rerun from the current main')
    body = pr_body(request, files, proposal)
    policy_report = report(request, files, body)
    print('stage=repository_policy status=' + policy_report['status'] + ' semantic_scope=unverified')
    entries = []
    for item in files:
        entry = {'path': item['path'], 'mode': item.get('mode', '100644'), 'type': 'blob'}
        if item['content'] is None:
            entry['sha'] = None
        elif item.get('encoding') == 'base64':
            entry['sha'] = api('POST', '/git/blobs', {'content': item['content'], 'encoding': 'base64'})['sha']
        else:
            entry['content'] = item['content']
        entries.append(entry)
    tree = api('POST', '/git/trees', {
        'base_tree': api('GET', f'/git/commits/{base}')['tree']['sha'], 'tree': entries})
    message = f'feat: implement requested changes\n\nCloses #{number}\n\nLatch automated proposal'
    commit = api('POST', '/git/commits', {'message': message, 'tree': tree['sha'], 'parents': [base]})
    try:
        ref = api('GET', '/git/ref/heads/' + branch)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        api('POST', '/git/refs', {'ref': 'refs/heads/' + branch, 'sha': commit['sha']})
    else:
        # Recover a prior create-PR failure without overwriting human changes.
        old = api('GET', '/git/commits/' + ref['object']['sha'])
        if old['tree']['sha'] != tree['sha'] or old['message'] != message or [p['sha'] for p in old['parents']] != [base]:
            raise ValueError('Existing automation branch differs; inspect manually before retrying')
    result = api('POST', '/pulls', {'head': branch, 'base': 'main', 'draft': True,
                                   'title': f'feat: implement Issue #{number}', 'body': body})
    print('Draft PR: ' + result['html_url'])


if __name__ == '__main__':
    try:
        main()
    except PolicyError as error:
        raise SystemExit(str(error)) from None
    except urllib.error.HTTPError as error:
        raise SystemExit(f'GitHub API HTTP {error.code}; check Actions PR permissions and repository policy')
