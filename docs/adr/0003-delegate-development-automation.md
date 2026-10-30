# ADR 0003: 開発の自動化を公式連携へ委譲する

状態: 採用。判断日: 2026-10-24。ADR整理日: 2026-10-30。

## 背景

独自のprepare/run/publish、gateway、候補検証・再公開機構は保守対象と資格情報・費用管理を増やしていた。

## 決定

公式OpenCode GitHub連携で実装と通常PR作成を行い、GitHub Actionsの通常PR CIで検証する。起動権限を照合する薄いauthorize処理だけを保持する。責務の置換は以下のとおり。

| 旧責務・ファイル                                                 | 置換・廃止・残存処理                                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare.mjs`、`policy.py`、prepare job                          | 削除。Issue/PR取得は公式連携。新workflowの小さなauthorizeステップだけがコマンド・現在権限・再実行者・開いた同一repoのPRを確認する。旧request schemaは不要 |
| `run.py`、`agent_metrics.py`、agent Dockerfile                   | 削除。実装・ツール反復・自己テストは公式Action。実行時間・直列化はActions。旧コンテナ境界・候補収集・独立検証は残さない                                   |
| `registry.py`、依存smoke、store受け渡し                          | 削除。#55の依存整合・キャッシュの目的はpnpm frozen install・Actions cacheとhead準備指示へ引き継ぐ。旧コンテナstoreの実装は移植しない                      |
| `gateway.py`、gateway Dockerfile                                 | 削除。DeepSeekへ公式providerから直接接続。旧5 USD費用予約・通信量・tokenizer境界とキー分離は維持しない。差分・監視・停止を運用手順に明記                  |
| `publish.py`、公開job                                            | 削除。公式のbranch/commit/通常PR作成・同じPRへの追加修正を採用。hashブランチ・所有マーカー・proposal schemaの完全互換は不要。人の変更保持・非forceを指示  |
| proposal・diagnostics artifact、専用再実行                       | 廃止。CIの結果は通常PRのChecks・Actionsログ。CIのみ再実行はGitHub標準機能                                                                                 |
| `.github/automation/` の旧テストとsmoke、`automation-checks.yml` | 参照先と共に削除。現行の起動制御をVitestでモック検証し通常CIへ含める。旧経路を並行保守しない                                                              |
| `issue-draft-pr.yml`                                             | 削除。コメント起点の `opencode.yml` に置換。`workflow_dispatch` による旧起動は終了                                                                        |
| PR本文・タイトル                                                 | 既存テンプレート・AGENTS・OpenCode指示を利用。最終回答と短いタイトル要約をAIが作成。未実行CIを成功としない。独自本文合成や結果同期は追加しない            |
| `.github/workflows/ci.yml`                                       | 既存の通常PR CIを継続。App作成PR・追加commitから起動する認証構成を採用し、実連動は別途確認                                                                |

## 検討した代替案

独自ループ・publisher・gatewayを維持する案は、標準機能と重複する保守が大きいため採らない。新しい有料SaaSや常駐サーバー、複数モデル切替層も追加しない。

## 影響

旧gatewayの厳密な費用予約上限、独立候補検証、旧コンテナ境界、artifact再公開の保証は引き継がない。人の変更保持・非force・未実行CIを成功にしない指示は維持するが、AIへの指示を技術的強制と同一視しない。実App/OIDC・モデル・CI連動の実証範囲は運用資料で確認する。

## 関連資料

[OpenCode運用](../opencode.md)、[アーキテクチャ](../../ARCHITECTURE.md)。判断の出典: [Issue #64](https://github.com/shion-kamimura/latch/issues/64)。
