# CI実行環境とGitHub Actionsの保守

## 対象と方針

現行の `.github/workflows/ci.yml` と `.github/workflows/opencode.yml` を対象に、GitHub ActionsのNode.js 20廃止警告へ対応します。旧 `automation-checks.yml`・`issue-draft-pr.yml` は #65 で削除済みであり、本対応では復元しません。

- 全ジョブの `runs-on` を `ubuntu-24.04` に固定する。`ubuntu-latest` を使わず、Ubuntu 26.04への移行も行わない。
- ワークフロー直下で使うActionをNode.js 24対応版へ更新する。
- アプリケーションの実行環境は `.node-version`・`engines`・`actions/setup-node` の `node-version: '26'` のまま維持する。ActionのNode.js 24とプロジェクトのNode.js 26は別物として扱う。
- 権限、Secrets、OpenCodeの認可・OIDC、起動条件、隔離方針、API予算は変更しない。

## Actionの変更前後と互換性

2026-10-25時点で各リポジトリのリリース・`action.yml` を確認しました。バージョンはメジャータグで指定し、確認時点の解決先も併記します。

| Action                      | 変更前             | 変更後                            | 確認した互換性                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions/checkout`          | `v4`（Node.js 20） | `v5`（確認時 v5.1.0、Node.js 24） | [v5 README](https://github.com/actions/checkout/blob/v5/README.md) がNode.js 24対応を明記。`v5.1.0` の `allow-unsafe-pr-checkout` は `pull_request_target`・`workflow_run` 向けで、本リポジトリの `pull_request`・`push`・`issue_comment` は対象外。`persist-credentials` などの既存入力は継続利用する。 |
| `pnpm/action-setup`         | `v4`（Node.js 20） | `v6`（確認時 v6.1.0、Node.js 24） | `v6.1.0` がpnpm v12対応を追加。`packageManager` の `pnpm@12.14.0` と `cache`・`run_install` の使い方を変えない。pnpm v11以降向けの後継 `pnpm/setup` への移行は、runtime取得方法と工程を変えるため本Issueの対象外とする。                                                                                 |
| `actions/setup-node`        | `v4`（Node.js 20） | `v5`（確認時 v5.0.0、Node.js 24） | [v5の変更点](https://github.com/actions/setup-node/blob/v5/README.md) はNode.js 24化と既定の自動キャッシュ有効化。本ワークフローは `cache: pnpm` を明示しているため既定値の変更に依存しない。`node-version: '26'` は変更しない。`always-auth` は使用していない。                                         |
| `actions/github-script`     | `v7`（Node.js 20） | `v8`（Node.js 24）                | [v8リリース](https://github.com/actions/github-script/releases/tag/v8) はNode.js 24化とrunner v2.327.1以上を要求。既存スクリプトが使う `core`・`context`・`github.rest` の使い方は変更しない。`v9` のESM化・`getOctokit`注入変更は本Issueに不要なため採用しない。                                        |
| `anomalyco/opencode/github` | SHA固定（v1.19.4） | 変更なし                          | composite actionでありNode.js runtimeを直接使わない。内部で参照する `actions/cache@v4` はSHA固定された第三者Actionの内側にあり、本リポジトリからは更新できない。詳細は「残る確認事項」に記録する。                                                                                                       |

Node.js 24対応の各Actionはrunner v2.327.1以上を要求します。本リポジトリはGitHub-hosted runnerだけを使い、self-hosted runnerは対象外です。

## 維持する実行内容

- `ci.yml` は `pnpm install --frozen-lockfile` の後、Lint、Typecheck、Format check、`pnpm test`、Buildをこの順で実行する。
- `pnpm test` は `vitest run --project unit --project integration` → `pnpm build` → `vitest run --project e2e` の順で、Unit・Integration → Build → CLI E2Eの順序を維持する。
- `opencode.yml` の `authorize` / `implement` の分離、write / maintain / adminの権限照合、`OPENCODE_ENABLED` の起動条件、`id-token: write` をimplementだけに与える構成、`use_github_token: false`、`persist-credentials: false`、concurrency、固定モデルと環境変数は変更しない。変更するのはrunnerとActionの版だけとする。

## artifactと廃止済み項目

- 現行の `ci.yml`・`opencode.yml` はartifactのアップロード・ダウンロードを行わない。旧workflowにあったartifact・保持期間・失敗時診断の保存は #65 で旧基盤とともに削除済みで、現行構成に対応するartifactの受け渡しはない。削除済み機能をこの対応で復元しない。
- `automation-checks.yml` のPython自動化テスト・Docker smokeと、`issue-draft-pr.yml` のprepare/run/publishは #65 で廃止済み。Python自動化テストを復元せず、現行のOpenCode起動制御は `tests/unit/opencode-authorization.test.ts` のモック試験と `tests/unit/workflows.test.ts` のworkflow構成試験で確認する。
- 旧workflowの実行結果に対する検証は、現行構成の検証とは区別する。Actionsログ・cacheの保存期間はGitHub設定側で管理し、独自artifactを追加しない。

## 確認した公式情報

- [actions/checkout v5 README](https://github.com/actions/checkout/blob/v5/README.md)
- [actions/checkout v5.1.0 release](https://github.com/actions/checkout/releases/tag/v5.1.0)
- [actions/setup-node v5 README](https://github.com/actions/setup-node/blob/v5/README.md)
- [actions/setup-node v5.0.0 release](https://github.com/actions/setup-node/releases/tag/v5.0.0)
- [actions/github-script v8 release](https://github.com/actions/github-script/releases/tag/v8)
- [pnpm/action-setup v6.1.0 release](https://github.com/pnpm/action-setup/releases/tag/v6.1.0)
- [actions/cache v5 release](https://github.com/actions/cache/releases/tag/v5.0.0)（OpenCode Action内の残存参照の確認用）

## 残る確認事項

- この変更を含むPRの通常CIと、main反映後のOpenCode起動は、作成・マージ後にGitHub Actionsで別途確認する。ローカルの設定試験はGitHub上の実行結果を代替しない。
- 固定した `anomalyco/opencode/github` の内側にある `actions/cache@v4` はNode.js 20 runtimeのままです。上流がNode.js 24対応の参照へ更新するまでは、実行ログに警告が残る可能性があります。本リポジトリのworkflow直下のActionはNode.js 24対応版へ更新済みで、第三者composite Actionの内側参照は本Issueの変更対象外です。
- GitHub-hosted `ubuntu-24.04` でのNode.js 26取得、pnpm 12のcache復元、OpenCodeのOIDC・App認証は、実際のworkflow実行で確認する。
