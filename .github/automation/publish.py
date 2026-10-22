"""Only trusted code runs in this job. Treat the proposal as hostile data."""

import hashlib
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


def list_prs(owner, branch):
    result = []
    for page in range(1, 101):
        items = api('GET', f'/pulls?state=all&head={owner}:{branch}&per_page=100&page={page}')
        result.extend(items)
        if len(items) < 100:
            return result
    raise ValueError('PR history exceeds supported lookup limit')


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
    drift = validate_issue(request, issue)
    owner = os.environ['GITHUB_REPOSITORY'].split('/')[0]
    existing = list_prs(owner, branch)
    expected_head = request.get('expected_head')
    source = request.get('source', base)
    marker = '<!-- latch-owner:' + issue['node_id'] + ' -->'
    proposal_id = hashlib.sha256(json.dumps({'source': source, 'request': request, 'proposal': proposal},
                                           sort_keys=True).encode()).hexdigest()
    message = f'feat: continue Issue #{number} proposal\n\nlatch-proposal:{proposal_id}\n' + marker
    try:
        current = api('GET', '/git/ref/heads/' + branch)['object']['sha']
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        current = None
    old = api('GET', '/commits/' + current) if current else None
    owned = bool(old and old.get('committer', {}).get('login') == 'github-actions[bot]'
                 and old['commit']['message'].endswith(marker))
    recovered = bool(owned and old['commit']['message'] == message
                     and [parent['sha'] for parent in old['parents']] == [source])
    if current != expected_head and not recovered:
        raise ValueError('Automation branch changed; preserve artifact and rerun without overwriting')
    if current and not owned:
        raise ValueError('Human changes detected; preserve artifact and rerun into a separate proposal')
    if expected_head and source != expected_head:
        raise ValueError('Source does not match the observed branch head')
    open_pr = next((pr for pr in existing if pr['state'] == 'open'), None)
    if open_pr:
        if (not open_pr.get('draft') or open_pr.get('user', {}).get('login') != 'github-actions[bot]'
                or marker not in (open_pr.get('body') or '')
                or open_pr.get('head', {}).get('sha') != (current if recovered else expected_head)):
            raise ValueError('Existing PR is not an unchanged owned draft; preserve artifact and rerun')
    elif existing:
        raise ValueError('Proposal branch has closed history; rerun to select a new revision branch')
    body = pr_body(request, files, proposal)
    if drift in {'changed', 'closed'}:
        body = body.replace(f'Closes #{number}', f'Refs #{number}')
    digest = hashlib.sha256(json.dumps([request['title'], request['body']], ensure_ascii=False).encode()).hexdigest()
    body += (f'\n\n要求スナップショットSHA256: {digest}\n'
             f'制御base: {base} / 検証入力commit: {source} / Issue状態差異: {drift}\n'
             '検証は上記入力に限られ、最新mainとの統合・変更後の要求充足は未検証です。\n' + marker)
    report(request, files, body)
    if not recovered:
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
            'base_tree': api('GET', f'/git/commits/{source}')['tree']['sha'], 'tree': entries})
        commit = api('POST', '/git/commits', {'message': message, 'tree': tree['sha'], 'parents': [source]})
        if current is None:
            api('POST', '/git/refs', {'ref': 'refs/heads/' + branch, 'sha': commit['sha']})
        else:
            # Parent is exactly the observed tip; force=false rejects concurrent divergence.
            if source != current:
                raise ValueError('Source does not match the observed branch head')
            api('PATCH', '/git/refs/heads/' + branch, {'sha': commit['sha'], 'force': False})
        latest = api('GET', '/git/ref/heads/' + branch)['object']['sha']
        if latest != commit['sha']:
            raise ValueError('Branch changed after publication; preserve artifact and inspect')
    if open_pr:
        result = api('PATCH', '/pulls/' + str(open_pr['number']), {'body': body})
    else:
        try:
            result = api('POST', '/pulls', {'head': branch, 'base': 'main', 'draft': True,
                                           'title': f'feat: implement Issue #{number}', 'body': body})
        except urllib.error.HTTPError as error:
            if error.code != 422:
                raise
            matches = [pr for pr in list_prs(owner, branch) if pr['state'] == 'open' and pr.get('draft')
                       and marker in (pr.get('body') or '') and pr.get('user', {}).get('login') == 'github-actions[bot]']
            if len(matches) != 1:
                raise ValueError('Concurrent PR creation could not be reconciled') from None
            result = matches[0]
    print('Draft PR: ' + result['html_url'])


if __name__ == '__main__':
    try:
        main()
    except PolicyError as error:
        raise SystemExit(str(error)) from None
    except urllib.error.HTTPError as error:
        raise SystemExit(f'GitHub API HTTP {error.code}; check Actions PR permissions and repository policy')
