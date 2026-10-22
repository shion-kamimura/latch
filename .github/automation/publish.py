"""Only trusted code runs in this job. Treat the proposal as hostile data."""

import json
import os
from pathlib import Path
import urllib.error
import urllib.request

from run import CHECKS
from policy import AUTOMATION_CHECK, PolicyError, report, validate_files, validate_issue, validate_request


def validate(proposal, maintenance=False):
    files, checks = proposal['files'], proposal['checks']
    validate_files(files, maintenance)
    if not files:
        return []
    expected = dict.fromkeys(CHECKS + ([AUTOMATION_CHECK] if maintenance else []), 0)
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


def pr_body(request, files):
    number = request['number']
    run_url = 'https://github.com/' + os.environ['GITHUB_REPOSITORY'] + '/actions/runs/' + os.environ['GITHUB_RUN_ID']
    body = (f'## 変更概要\n\nIssue #{number} の要件に基づく自動実装です。差分を人間がレビューしてください。\n\n'
            f'## 関連Issue\n\nCloses #{number}\n\n## 実装内容\n\n'
            + '\n'.join('- `' + item['path'] + '`' for item in files)
            + '\n\n## 実行したテスト\n\n'
            + '\n'.join('- `pnpm ' + check + '`: 成功（独立コンテナで終了コード0）' for check in CHECKS)
            + ('\n- Python自動化テスト（変更前の境界テスト・候補テスト）: 成功（独立コンテナで終了コード0）'
               if request.get('allow_maintenance', False) else '')
            + '\n\n## テスト結果\n\n独立チェックはすべて終了コード0でした。\n\n`pnpm test`のUnit・Integration → Build → CLI E2Eの順序は変更していません。'
            + '\n\n## 未検証事項\n\n受け入れ条件全体の充足は人間による確認が必要です。'
            + '実サービス接続、Windows/macOS、ネットワークが必要な追加検証は未実施です。'
            + '生成したテスト自体の妥当性もレビューしてください。'
            + 'Issueとの意味的整合、受け入れ条件全体、設計・依存・権限変更の事前承認は未検証です。'
            + '保守変更は提案データとして扱い、変更前の信頼したポリシーで検証しています。'
            + 'ワークフロー権限・自動化の安全性は人間の承認前に適用しないでください。'
            + f'\n\n[実行ログ]({run_url})\n\nGITHUB_TOKENで作成したPRは通常のPR CIを自動起動しません。'
            + 'この実行の検証結果を確認し、必要なら人間がブランチを更新して通常CIも実行してください。')
    return body


def main():
    request = json.loads(Path(os.environ['REQUEST_PATH']).read_text())
    proposal_path = Path(os.environ['OUTPUT_PATH']) / 'proposal.json'
    if proposal_path.is_symlink() or proposal_path.stat().st_size > 500_000:
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
    body = pr_body(request, files)
    policy_report = report(request, files, body)
    print('stage=repository_policy status=' + policy_report['status'] + ' semantic_scope=unverified')
    tree = api('POST', '/git/trees', {
        'base_tree': api('GET', f'/git/commits/{base}')['tree']['sha'],
        'tree': [dict(path=item['path'], mode='100644', type='blob',
                      **({'sha': None} if item['content'] is None else {'content': item['content']})) for item in files]})
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
