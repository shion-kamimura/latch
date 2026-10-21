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

引数なし、または `-h` でもヘルプを表示します。未対応の引数は標準エラーに案内を出力し、終了コード1を返します。

## 開発フローとCI

`src/cli.ts` がエントリーポイントです。`src/run-cli.ts` が引数と出力を処理し、`src/help.ts` がヘルプを提供します。

Issueテンプレートに目的・期待動作・スコープ・受け入れ条件を記載し、Issue単位のブランチで開発してください。AIエージェント向けのルールは [AGENTS.md](AGENTS.md) に定義しています。

Pull Request作成・更新時とmainへのpush時に、Node.js 26とpnpmでLint、型チェック、フォーマット確認、全テスト、ビルドを実行します。PRテンプレートには実行した検証結果と未検証事項を記載してください。
