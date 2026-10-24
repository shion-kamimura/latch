# Latch

Latchは、AIが生成したコードをGitHub IssueやPRの要件と照合し、実際のテスト結果や証拠に基づいて検証するオープンソースのCLIツールです。

現在は開発基盤とヘルプ表示のみを提供しています。コード検証機能はまだ実装していません。

## 使用技術

- Node.js 26 / TypeScript（strictモード、ES Modules）
- pnpm（packageManagerで固定、lockfileをGit管理）
- tsdown（ビルド）/ tsc（型チェック）
- Vitest（Unit・Integration・CLI E2E）
- ESLint / typescript-eslint / Prettier
- GitHub Actions

## 開発環境のセットアップ

Node.js 26（`.node-version` 参照）と、`package.json` の `packageManager` に記載したpnpmをインストールしてください。

```sh
npm install --global pnpm@12.14.0
git clone https://github.com/shion-kamimura/latch.git
cd latch
pnpm install
```

CIやlockfileとの整合性を確認する場合は `pnpm install --frozen-lockfile` を使用します。

## 開発コマンド

| コマンド            | 用途                                 |
| ------------------- | ------------------------------------ |
| `pnpm lint`         | ESLintによる静的解析                 |
| `pnpm typecheck`    | `tsc --noEmit` による型チェック      |
| `pnpm test`         | Unit・Integration → ビルド → CLI E2E |
| `pnpm build`        | tsdownで `dist/cli.mjs` を生成       |
| `pnpm format`       | Prettierによる整形                   |
| `pnpm format:check` | フォーマットの検証                   |

## テスト

```sh
pnpm test
```

- `tests/unit/`: 個別の関数のテスト
- `tests/integration/`: CLI処理とヘルプ・出力の連携テスト
- `tests/e2e/`: Node.js subprocessでビルド済みCLIを実行し、終了コード・標準出力・標準エラーを確認

`pnpm test` はビルドが成功した場合だけE2Eを実行します。UnitとIntegrationだけを実行する場合は次のコマンドを使用します。

```sh
pnpm exec vitest run --project unit --project integration
```

## ビルドとCLIの実行

```sh
pnpm build
node dist/cli.mjs --help
```

引数なし、または `-h` でもヘルプを表示します。`-v` または `--version` で `package.json` に定義されたバージョンを表示します。未対応の引数は標準エラーに案内を出力し、終了コード1を返します。

## 開発フローとCI

### AIとIssueを設計する

参照資料、要件の整理方法、依頼に基づくIssue登録の運用は [Issue設計ガイド](docs/issue-design.md) にまとめています。新しいチャットでは、相談内容とともに次のように依頼してください。

```text
https://github.com/shion-kamimura/latch の最新の docs/issue-design.md を参照し、
「○○」をIssueにまとめて、GitHubに登録してください。
作業に必要な情報が不足していれば質問し、参照できない資料は明示してください。
追加承認を待たずに登録し、作成したIssueのURLを報告してください。
```

案だけが必要なら「案だけ。登録しないで」、登録前に確認したい場合は「承認後に作成して」と指定してください。設計相談だけの依頼ではIssueを登録しません。

### 実装と検証

Issueタイトルには解決したい課題・期待する動作を簡潔・具体的に書き、`[Feature]` などの種別接頭辞は必須にしません。種類は `enhancement`・`bug`・`documentation` などの既存ラベルで分類します。[種別ラベルの対応](docs/issue-design.md#issueの種別ラベル) を参照してください。

手動・AI・自動生成のPRタイトルは `<type>: <具体的な変更内容>` に統一します。主目的に合わせて `feat`（機能追加）、`fix`（不具合修正）、`docs`（文書）、`refactor`（動作を変えない構造整理）、`test`（テスト）、`ci`（CI）、`chore`（開発環境・保守）を選びます。例は `docs: Issue登録時の追加承認を不要にする`、`fix: 未対応引数で終了コード1を返す`、`feat: PRの要件を抽出する` です。関連Issueは本文の `Closes #番号` などで紐づけ、タイトルのIssue番号は必須にしません。

Conventional Commitsは本来コミットメッセージの規約ですが、Latchではその形式をPRタイトルにも採用しています。これはリポジトリの方針であり、業界共通の必須規格ではありません。詳細は [AGENTS.md](AGENTS.md) を参照してください。

依頼された実装は、必要な確認・検証の後、専用ブランチへのコミット・push・Draft PR作成まで追加承認なしに進め、変更内容・検証結果・未検証事項とURLを報告します。利用者による作成範囲の指定を優先し、レビュー承認・マージ・デプロイや権限・Secrets変更は別に扱います。実行プラットフォーム側の承認・認証制約は [AGENTS.md](AGENTS.md) の運用変更では無効化できません。

IssueからOpenCode / DeepSeekで実装・検証し、Draft PRを作成する手動ワークフローは [IssueからDraft PRを作成する](docs/issue-draft-pr.md) を参照してください。

自動化の責務、OpenCode・pnpm・Actionsへの委譲方針、費用・保存期間と後続改善 #54〜#57の順序は [標準機能への委譲設計](docs/automation-delegation.md) を参照してください。キャッシュは後続実装です。保存候補の検証だけを再実行する手順と保持期間は [検証専用経路](docs/issue-draft-pr.md#保存候補の検証だけを再実行する56) を参照してください。

自動化の分割実装・横断モック検証と未検証事項は [#32検証記録](docs/ai-development-validation.md) にまとめています。

PR作成前にローカル差分とIssueをLatchで検証する入力・出力・異常時の扱い・分割案は [PR作成前のローカル差分とIssueを検証する利用仕様](docs/pre-pr-verification.md) にまとめています。これは利用仕様であり、検証機能はまだ実装していません。利用者設定による送信許可の再利用、閉じたIssueの再現検証、隔離した依存準備と制御されたテスト通信も仕様として整理しています。実装は #23〜#26で進めます。

`src/cli.ts` がエントリーポイントです。`src/run-cli.ts` が引数と出力を処理し、`src/help.ts` がヘルプを提供します。

Issueテンプレートに目的・期待動作・スコープ・受け入れ条件を記載し、専用ブランチで開発してください。ライブラリ選定・テスト配置・内部構造の整理は理由と仮定を記して進めます。依頼外の互換性破壊や実環境の権限適用など、具体的な影響がある判断に確認を絞ります。AIエージェント向けのルールは [AGENTS.md](AGENTS.md) に定義しています。

Pull Request作成・更新時とmainへのpush時に、Node.js 26とpnpmでLint、型チェック、フォーマット確認、全テスト、ビルドを実行します。PRテンプレートには実行した検証結果と未検証事項を記載してください。
