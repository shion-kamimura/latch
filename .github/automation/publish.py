"""Only trusted code runs in this job. Treat the proposal as hostile data."""

import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request

from run import CHECKS, allowed


def validate(proposal):
    files, checks = proposal['files'], proposal['checks']
    if not isinstance(files, list) or len(files) > 100:
        raise ValueError('Invalid files')
    if not files:
        return []
    if checks != dict.fromkeys(CHECKS, 0):
        raise ValueError('All independent checks must pass')
    seen = set()
    for item in files:
        path, content = item['path'], item['content']
        if not isinstance(path, str) or not allowed(path) or path in seen:
            raise ValueError('Unsafe or duplicate publication path')
        if content is not None and (not isinstance(content, str) or '\x00' in content):
            raise ValueError('Only UTF-8 text files are allowed')
        seen.add(path)
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


def main():
    request = json.loads(Path(os.environ['REQUEST_PATH']).read_text())
    proposal_path = Path(os.environ['OUTPUT_PATH']) / 'proposal.json'
    if proposal_path.is_symlink() or proposal_path.stat().st_size > 500_000:
        raise ValueError('Invalid proposal size/type')
    proposal = json.loads(proposal_path.read_text())
    files = validate(proposal)
    if not files:
        print('No changes; no PR created.')
        return
    base, branch, number = request['base'], request['branch'], request['number']
    if not re.fullmatch(r'[0-9a-f]{40}', base) or not re.fullmatch(r'feat/automated-[0-9a-f]{16}', branch):
        raise ValueError('Invalid trusted request')
    issue = api('GET', f'/issues/{number}')
    expected = 'feat/automated-' + hashlib.sha256(issue['node_id'].encode()).hexdigest()[:16]
    if issue['state'] != 'open' or 'pull_request' in issue or branch != expected:
        raise ValueError('Issue changed or request mismatch')
    owner = os.environ['GITHUB_REPOSITORY'].split('/')[0]
    existing = api('GET', f'/pulls?state=all&head={owner}:{branch}&per_page=100')
    if existing:
        print('PR already exists; no duplicate created.')
        return
    if api('GET', '/git/ref/heads/main')['object']['sha'] != base:
        raise ValueError('main changed during implementation; rerun from the current main')
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
    run_url = 'https://github.com/' + os.environ['GITHUB_REPOSITORY'] + '/actions/runs/' + os.environ['GITHUB_RUN_ID']
    body = (f'## 変更概要\n\nIssue #{number} の要件に基づく自動実装です。差分を人間がレビューしてください。\n\n'
            f'## 関連Issue\n\nCloses #{number}\n\n## 実装内容\n\n'
            + '\n'.join('- `' + item['path'] + '`' for item in files)
            + '\n\n## 実行したテスト・テスト結果\n\n'
            + '\n'.join('- `pnpm ' + check + '`: 成功（独立コンテナで終了コード0）' for check in CHECKS)
            + '\n\n`pnpm test`のUnit・Integration → Build → CLI E2Eの順序は変更していません。'
            + '\n\n## 未検証事項\n\n受け入れ条件全体の充足は人間による確認が必要です。'
            + '実サービス接続、Windows/macOS、ネットワークが必要な追加検証は未実施です。'
            + '生成したテスト自体の妥当性もレビューしてください。'
            + f'\n\n[実行ログ]({run_url})\n\nGITHUB_TOKENで作成したPRは通常のPR CIを自動起動しません。'
            + 'この実行の検証結果を確認し、必要なら人間がブランチを更新して通常CIも実行してください。')
    result = api('POST', '/pulls', {'head': branch, 'base': 'main', 'draft': True,
                                   'title': f'feat: implement Issue #{number}', 'body': body})
    print('Draft PR: ' + result['html_url'])


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit(f'GitHub API HTTP {error.code}; check Actions PR permissions and repository policy')
