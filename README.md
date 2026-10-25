# Latch

Latchは、AIが生成したコードをGitHub IssueやPRの要件と照合し、実際のテスト結果や証拠に基づいて検証するオープンソースのCLIツールです。

現在は開発基盤、ヘルプ表示、`latch verify` の入力解決（リポジトリ境界・base・差分・Issueファイル）、`latch plan` による要件抽出・既存Vitestテスト候補と不足シナリオの計画、`latch run` によるVitestテスト生成・隔離実行・実行証拠の収集と、要件→テスト→証拠を対応づけたテキスト／JSONレポートを提供しています。Markdownファイル出力・CI連携・GitHub PR投稿はまだ実装していません。

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

## 評価用のサンプルAPIと正解データ

Latchの検証結果を照合するための評価用fixtureを [fixtures/order-api](fixtures/order-api/README.md) に置いています。TypeScript / Node.js・Vitestの小さな注文合計APIで、外部サービス不要です。

- base・正しい変更 `changes/correct.patch`・不具合のある変更 `changes/buggy.patch` を再現できる。
- `issue.md` を Issue入力として渡せる。
- `evaluation/cases.json` に正常系・異常系・境界値の期待結果と検出すべき不具合を記録している。
- baseと不具合のある変更は既存テストを通り、評価専用テストだけが不具合を検出する。正しい変更は両方を通る。
- `evaluation/` の正解データと評価専用テストは候補コピーに含めず、Latchの探索対象・LLM入力へ混入させない。

```sh
node fixtures/order-api/scripts/prepare-candidate.ts correct
```

依存準備・隔離実行の方針・未検証事項は [fixtureのREADME](fixtures/order-api/README.md) を参照してください。

## ビルドとCLIの実行

```sh
pnpm build
node dist/cli.mjs --help
```

引数なし、または `-h` でもヘルプを表示します。`-v` または `--version` で `package.json` に定義されたバージョンを表示します。未対応の引数は標準エラーに案内を出力し、終了コード1を返します。

### 検証入力を解決する

```sh
node dist/cli.mjs verify --base origin/main --issue-file fixtures/order-api/issue.md
node dist/cli.mjs verify --base origin/main --issue-file fixtures/order-api/issue.md --json
```

`verify` はリポジトリ境界を確定し、baseとのmerge-base、コミット済み・未コミットの差分、Issueファイルを1つのスナップショットへ解決します。未追跡ファイルは既定で除外し、`--include-untracked <path>` で明示した通常ソースだけを取り込みます。この段階では入力を収集するだけで、要件の検証は実行しません。入力の解決に成功しても終了コード0は「要件を満たした」ことを意味しません。詳細は [利用仕様](docs/pre-pr-verification.md) を参照してください。

### 要件を抽出して検証シナリオを計画する

```sh
node dist/cli.mjs plan --base origin/main --issue-file fixtures/order-api/issue.md \
  --profile ~/.config/latch/llm-profile.json
node dist/cli.mjs plan --base origin/main --issue-file fixtures/order-api/issue.md \
  --profile ~/.config/latch/llm-profile.json --json
```

`plan` は `verify` と同じ入力スナップショットから、要件・条件、出典（Issue明示または差分推定）、既存のVitestテスト候補、不足シナリオを計画します。期待値を確定できない条件は「要件不明確」として残し、テスト候補と実行証拠を区別します。対象コード・設定・テストは実行せず、#22の評価専用テスト・正解データはLLM入力から除外します。

送信にはワークツリー外の利用者管理の許可profileと、環境変数（既定は `LATCH_API_KEY`）のBYOKキーが必要です。許可profileはprovider・endpoint・project・データ区分を検証し、同一範囲は追加確認なしに再利用します。拒否・取り消し・範囲拡大・非対話の許可不足では送信せず終了コード2を返します。APIキーはprofile・ログ・レポートへ保存しません。認証失敗・タイムアウト・利用上限・不正なLLM応答は上限内で停止します。

自動テストは固定したLLM応答を使い、実APIでの抽出品質は評価していません。テスト生成・実行・証拠収集は `latch run` で実装し、隔離方式・安全境界・依存準備・通信制御・状態の区別は [生成テストの隔離実行と証拠収集](docs/isolated-execution.md) を参照してください。利用方法・許可profile・データ契約・確認と再計画の手順は [要件抽出と検証シナリオ計画](docs/requirement-planning.md) を参照してください。

### 不足テストを生成して隔離実行する

```sh
node dist/cli.mjs plan --base origin/main --issue-file fixtures/order-api/issue.md \
  --profile ~/.config/latch/llm-profile.json --json > latch-plan.json
node dist/cli.mjs run --plan latch-plan.json \
  --profile ~/.config/latch/llm-profile.json --json
```

`run` は計画JSONの入力スナップショットを再解決して一致を確認し、不足シナリオからVitestテストを生成します。固定入力の一時コピーを`git archive`から作り、既存テストと生成テストを区別して実行し、条件ID・テスト内容・実行コマンド・終了コード・ログを対応づけたレポートを出力します。対象コードをホストのワークツリーで直接実行せず、元のワークツリー・未コミット・未追跡ファイルへ書き戻しません。

子プロセスはNode.jsのパーミッションモデルでファイル読み書きを制限し、テスト通信を既定で遮断します。Git資格情報・APIキー・ホーム・Docker socketは渡しません。隔離や依存準備を利用できない場合はホスト実行へ切り替えず「実行不能・判定不能」として停止します。生成テスト不正・起動失敗・環境不足は製品不具合の証拠にしません。

レポートは既定で日本語テキスト、`--json`で`schemaVersion: "1"`を持つ機械可読JSONを標準出力へ出します。進捗・警告は標準エラーへ分離し、要件ごとの集約状態、条件と実行証拠の対応、未検証事項、再実行コマンドを含みます。要件内に検証成功以外の条件があれば要件を検証成功に集約しません。検証を完了できた場合は失敗条件を含んでも終了コード0、入力不正は1、起動失敗・環境不足・時間上限などで部分結果しか出せない場合は終了コード2です。テスト成功は要件全体・コード全体の正しさの証明ではありません。設計理由・依存準備の方式・制約・未検証事項は [生成テストの隔離実行と証拠収集](docs/isolated-execution.md) を参照してください。

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

依頼された実装は、必要な確認・検証の後、専用ブランチへのコミット・push・通常PR作成まで追加承認なしに進め、変更内容・検証結果・未検証事項とURLを報告します。利用者による作成範囲の指定を優先し、レビュー承認・マージ・デプロイや権限・Secrets変更は別に扱います。実行プラットフォーム側の承認・認証制約は [AGENTS.md](AGENTS.md) の運用変更では無効化できません。

Issueで `/opencode このIssueを実装してください` または `/oc このIssueを実装してください` とコメントし、公式OpenCode GitHub連携とDeepSeekに実装・自己テスト・通常PR作成を任せます。PR上のコメントで同じPRへの修正を依頼し、対象commitのChecksとActionsログで通常CIを確認します。自動承認・自動マージ・CI失敗からの無人修復は行いません。

App・Secrets・有効化、起動権限、費用と停止方法、移行・切り戻しと未検証事項は [OpenCode運用手順](docs/opencode.md)、旧責務の置換は [委譲設計](docs/automation-delegation.md) を参照してください。旧Draft経路とその [検証記録](docs/ai-development-validation.md) は過去の構成です。

PR作成前にローカル差分とIssueをLatchで検証する入力・出力・異常時の扱い・分割案は [PR作成前のローカル差分とIssueを検証する利用仕様](docs/pre-pr-verification.md) にまとめています。このうち #23 の入力解決、#24 の要件抽出・検証計画、#25 のテスト生成・隔離実行・証拠収集、#26 の要件→テスト→証拠を対応づけたテキスト・JSONレポートを実装済みです。Markdownファイル出力、CI連携、GitHub PR投稿は未実装です。利用者設定による送信許可の再利用、閉じたIssueの再現検証、隔離した依存準備と制御されたテスト通信を仕様として整理しています。実APIの品質評価は未実施です。

`src/cli.ts` がエントリーポイントです。`src/run-cli.ts` が引数と出力を処理し、`src/help.ts` がヘルプを提供します。`src/verify/` が入力解決、`src/plan/` が要件抽出・計画、`src/run/` がテスト生成・隔離実行・証拠収集を担当します。

Issueテンプレートに目的・期待動作・スコープ・受け入れ条件を記載し、専用ブランチで開発してください。ライブラリ選定・テスト配置・内部構造の整理は理由と仮定を記して進めます。依頼外の互換性破壊や実環境の権限適用など、具体的な影響がある判断に確認を絞ります。AIエージェント向けのルールは [AGENTS.md](AGENTS.md) に定義しています。

Pull Request作成・更新時とmainへのpush時に、Node.js 26とpnpmでLint、型チェック、フォーマット確認、全テスト、ビルドを実行します。PRテンプレートには実行した検証結果と未検証事項を記載してください。全ジョブは `ubuntu-24.04` に固定し、ActionsはNode.js 24対応版を使用します。変更前後の版と互換性の確認結果は [CI実行環境とGitHub Actionsの保守](docs/ci.md) に記録しています。
