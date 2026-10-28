import type {
  ChangedFile,
  ExclusionReason,
  VerificationInputSnapshot,
} from './types.js';

const exclusionLabels: Record<ExclusionReason, string> = {
  credential: '認証情報のパス',
  binary: 'バイナリ',
  symlink: 'シンボリックリンク',
  submodule: 'submodule',
  'git-internal': '.git配下',
  'outside-boundary': 'リポジトリ境界外',
  'not-utf8': 'UTF-8以外',
};

function statusLine(file: ChangedFile): string {
  const stat =
    file.additions === null || file.deletions === null
      ? ''
      : ` (+${file.additions}/-${file.deletions})`;
  return `  ${file.status} ${file.path}${stat}`;
}

function section(title: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  return [title, ...lines, ''];
}

export function renderText(snapshot: VerificationInputSnapshot): string {
  const lines: string[] = [
    'Latch input resolution',
    '',
    '入力',
    `  リポジトリ: ${snapshot.repository.root}`,
    `  HEAD: ${snapshot.repository.head}`,
    `  base: ${snapshot.base.ref}${snapshot.base.requested ? '（指定）' : '（既定）'}`,
    `  比較基点: ${snapshot.base.mergeBase}（merge-base）`,
    `  差分: コミット済み ${snapshot.diff.files.filter((file) => file.kind === 'committed').length} 件 / 未コミット ${snapshot.diff.files.filter((file) => file.kind === 'uncommitted').length} 件 / 未追跡（明示） ${snapshot.diff.untracked.length} 件`,
    ...(snapshot.issue
      ? [
          `  Issue: ${snapshot.issue.path}`,
          `    タイトル: ${snapshot.issue.title}`,
          `    状態: ${snapshot.issue.state}`,
          `    出典: ${snapshot.issue.source}`,
        ]
      : ['  Issue: 指定なし（要件は差分からしか推定できません）']),
    '',
  ];

  for (const kind of ['committed', 'uncommitted'] as const) {
    const files = snapshot.diff.files.filter((file) => file.kind === kind);
    lines.push(
      ...section(
        kind === 'committed' ? 'コミット済みの変更' : '未コミットの変更',
        files.map(statusLine),
      ),
    );
  }

  lines.push(
    ...section(
      '明示指定した未追跡ファイル',
      snapshot.diff.untracked.map((file) => `  ${file.path}`),
    ),
  );

  lines.push(
    ...section(
      '除外したパス',
      snapshot.diff.excluded.map(
        (file) => `  ${file.path}: ${exclusionLabels[file.reason]}`,
      ),
    ),
  );

  lines.push(
    ...section(
      '警告',
      snapshot.warnings.map((text) => `  ${text}`),
    ),
  );

  lines.push(
    ...section('再現性', [
      `  CI再現性: ${snapshot.reproducibility.ciReproducible ? 'あり' : 'なし'}`,
      ...snapshot.reproducibility.notes.map((note) => `  - ${note}`),
    ]),
  );

  lines.push(
    'スナップショット',
    `  digest: sha256:${snapshot.digest}`,
    `  diff digest: sha256:${snapshot.diff.digest}`,
    '  後続処理はこのスナップショットだけを入力として使用してください。',
    '',
    '再実行',
    `  ${snapshot.rerunCommand}`,
    '',
    '入力の解決のみを行いました。要件の検証はまだ実行していません。',
    '',
  );

  return lines.join('\n');
}

export function renderJson(snapshot: VerificationInputSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
