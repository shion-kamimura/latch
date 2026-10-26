# Latch

Latchは、AIが生成したコードをGitHub IssueやPRの要件と照合し、実際のテスト結果や証拠に基づいて検証するオープンソースのCLIツールです。

現在は開発基盤、ヘルプ表示、`latch verify` の入力解決（リポジトリ境界・base・差分・Issueファイル）、`latch plan` による要件抽出・既存Vitestテスト候補と不足シナリオの計画、`latch run` によるVitestテスト生成・隔離実行・実行証拠の収集と、要件→テスト→証拠を対応づけたテキスト／JSONレポートを提供しています。Markdownファイル出力・CI連携・GitHub PR投稿はまだ実装していません。

製品は既存の公式ツール・標準機能を優先し、自前実装と資格情報管理を減らす方針です。責務の分担は [製品方針](docs/product-vision.md#自前実装を最小化する原則) を参照してください。[#81の公式CLI移行](docs/official-cli.md) は調査中で、現行のBYOK接続はまだ残っています。公式CLI対応済みとは扱いません。

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

計画から生成・隔離実行・テキスト／JSONレポートまでの接続は、[全工程の評価手順と制約](docs/order-api-evaluation.md) にまとめています。固定応答の回帰テストは正しい変更・既存テストを通る不具合・曖昧な要件・実行時間超過を比較し、要件と実行証拠の対応、正解データの送信除外、対象ワークツリーの不変性を確認します。

```sh
pnpm build
pnpm exec vitest run --project e2e tests/e2e/evaluation.test.ts
```

Node.js 26、リポジトリの開発依存、loopback通信が必要です。固定応答の合格から抽出・生成品質やAPI全体の正しさを保証しません。旧BYOK方式での実API評価は取りやめ、公式CLIでの実利用評価を #81 へ引き継ぎます。採用条件、契約と利用上限、誤検出・見逃し・未検証の記録方法は上記手順を参照してください。

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

## 開発に参加する

資料の役割と実装状態は [ドキュメント索引](docs/README.md)、コードの責務は [アーキテクチャ](ARCHITECTURE.md) を参照してください。

- Issue設計: [Issue設計ガイド](docs/issue-design.md)
- 実装・検証・通常PRの作成: [開発手順](docs/development.md)
- AIの作業開始: [AGENTS.md](AGENTS.md)
- OpenCodeの起動・停止・権限・費用: [運用手順](docs/opencode.md)
- 開発ハーネスの設計・評価・改善: [設計方針](docs/harness/design.md)

開発環境は `node scripts/check-environment.ts` で確認できます。これはバージョンと依存の読取検査であり、テストの成功や隔離の安全性を判定するものではありません。準備・失敗時の手順は [開発手順](docs/development.md) を参照してください。

Pull Request作成・更新時とmainへのpush時に、Node.js 26とpnpmでLint、型チェック、フォーマット確認、全テスト、ビルドを実行します。全ジョブは `ubuntu-24.04` に固定し、ActionsはNode.js 24対応版を使用します。変更前後の版と互換性の確認結果は [CI実行環境とGitHub Actionsの保守](docs/ci.md) に記録しています。
