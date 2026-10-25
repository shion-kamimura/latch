# 開発手順

状態: 現行。環境準備・実装・検証・PR規則の正本。OpenCodeの起動・権限・費用は [運用手順](opencode.md)、Issue登録は [Issue設計](issue-design.md) を参照してください。

## 1. 対象を確かめる

対象Issueの目的・受け入れ条件と最新default branchを確認し、`git status --short` で他人の変更を調べます。新規作業は専用ブランチ、PR修正はそのheadを使います。未コミットの変更を捨てたりforce pushしたりしません。競合・権限不足では状態を残して報告します。

## 2. 環境を準備する

Node.jsは [.node-version](../.node-version)、pnpmは [package.json](../package.json) のpackageManagerに合わせます。現在はNode.js 26、pnpm 12.14.0です。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
node scripts/check-environment.ts
```

環境チェックはネットワークアクセスやinstallをせず、Node・pnpmのバージョン、lockfile、開発依存の解決を確認します。終了コード0は準備項目の成功、1は不足です。これはテスト成功や依存の完全な整合性、隔離の安全性を証明しません。pnpmの版確認時はCorepackのnetwork取得とpnpmの自動版切替を無効化します。PATH上の実行ファイル自体は信頼できる開発ツールを使ってください。Node 24でも読取診断を試せますが、ビルド・テストには26が必要です。

pnpmがない場合は指定版を準備し、Nodeが異なる場合は既存のバージョン管理ツール等で切り替えます。接続・権限・proxyで失敗したら原因と未実行項目を記録し、承認・認証を迂回しません。依存不足を製品不具合として扱いません。

新しいheadに切り替えた場合はそのmanifestとlockfileで準備し直します。依存を意図して変更する場合だけ通常のinstallでlockfileも更新します。cache hitやbaseのinstall成功はheadの準備・テスト成功を意味しません。

## 3. 小さく変更して検証する

関連仕様・コード・既存テストを読み、実装判断の理由・仮定を残します。動作変更には必要なUnit・Integration・CLI E2Eの層でテストを追加・更新します。文書だけの変更に文言一致テストを増やす必要はありません。

基盤の変更では次を実行します。

```sh
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
```

`pnpm test` はUnit・Integration → build → CLI E2Eの順です。この中のbuildが成功していれば同じ成果物を再buildする必要はありません。小さな変更では影響範囲に合う検証を選びます。CLIはbuild後に `node dist/cli.mjs --help` で確認できます。

失敗したら、今回の不具合、既存不具合、環境不足、採点・テスト側の誤りを分けます。コマンド、終了結果、対象commit、未検証事項を報告し、秘密情報をログへ残しません。

## 4. 差分を確認して通常PRを作る

依頼された実装は、差分と受け入れ条件を照合し、専用ブランチへcommit・pushして通常PRを作成します。追加の作成承認は不要です。「案だけ」等の指定を優先し、レビュー承認・マージ・デプロイ・実権限・Secrets変更は別の操作として扱います。

PR・commitのタイトルは `<type>: <具体的な変更内容>`。主目的からtypeを選びます。

| type     | 用途                   |
| -------- | ---------------------- |
| feat     | 機能追加               |
| fix      | 不具合修正             |
| docs     | 文書のみ               |
| refactor | 動作を変えない構造整理 |
| test     | テスト                 |
| ci       | CI                     |
| chore    | 開発環境・保守         |

例: `fix: 未対応引数で終了コード1を返す`。付随するテストや文書だけで主目的のtypeを変えません。Conventional Commitsの形式をPRにも使うリポジトリ方針で、業界共通の必須規格という意味ではありません。

[PRテンプレート](../.github/pull_request_template.md) の6見出しで、動作・理由・受け入れ条件への対応、実行したテスト・結果・未検証事項を書きます。全条件を満たしたIssueだけ `Closes #番号`、親Issueの一部なら `Refs #番号` を使います。タイトルへの番号は必須ではありません。

## 5. 対象commitのCIを確認して報告する

自己テストと通常PR CIは別の実行です。PR作成時点の未実行CIは「実行待ち／未確認」とし、その後は対象SHAのChecks・Actionsログで確認します。CI終了ごとの本文同期はしません。修正したら同じPRへ追加commitして再確認します。

完了の説明には依頼に対応する差分・検証・PR・残項目を含めます。中断時は [引き継ぎ手順](harness/plan.md) を使います。
