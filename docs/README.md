# ドキュメント索引

開発ハーネスは、AIが会話の記憶に頼らず依頼を理解し、変更・検証・PR・報告まで進めるための作業環境と手順です。製品CLIの仕様や評価記録を、毎回読む指示には含めません。入口は [AGENTS](../AGENTS.md)、実装状況は [README](../README.md)、コードの責務は [アーキテクチャ](../ARCHITECTURE.md) です。

## 開発ハーネスで使う資料

| 資料                                  | 必要になる作業・保持理由                                                  |
| ------------------------------------- | ------------------------------------------------------------------------- |
| [開発手順](development.md)            | 実装・PR修正の基本資料。環境準備、検証、PR規則の正本を一本化する          |
| [Issue設計](issue-design.md)          | Issue設計・登録時のみ。要件と受け入れ条件、テンプレートの使い方を確認する |
| [OpenCode運用](opencode.md)           | OpenCode利用・保守時のみ。起動権限、費用、停止・再依頼を確認する          |
| [CI保守](ci.md)                       | workflow変更・CI障害調査時のみ。Action/OSの採用理由と未検証事項を確認する |
| [設計判断（ADR）](adr/README.md)      | 設計変更時。背景・決定・代替案・影響を主題別に確認する                    |
| [ハーネス評価](harness/evaluation.md) | ハーネス改善の評価時のみ。代表ケース、採点、証拠の記録方法を確認する      |

毎回読む対象は依頼に関係する資料だけです。ADR・評価資料も通常の製品実装では一式読込を要求しません。

## 設計判断の索引

- [ADR 0001: 文書の責務](adr/0001-documentation-ownership.md)
- [ADR 0002: 最小構成の開発ハーネス](adr/0002-minimal-development-harness.md)
- [ADR 0003: 開発自動化の委譲](adr/0003-delegate-development-automation.md)
- [ADR 0004: 製品の公式CLI接続](adr/0004-official-model-cli.md)

## 製品の作業時に参照する資料

以下は開発ハーネスの基本手順には不要ですが、製品の仕様・安全境界・検証方法の正本として保持します。担当する機能に応じて選びます。

| 資料                                              | 必要になる作業・保持理由                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [製品方針](product-vision.md)                     | 要件・設計判断。目的と公式ツール優先の原則を確認する。構想・未決定事項を含む                           |
| [コードレビュー操作ガイド](review-walkthrough.md) | 初回利用・WSL 2での操作確認。利用者向けの一連の操作を再現する                                          |
| [PR前検証の利用仕様](pre-pr-verification.md)      | verify・入力・レポートの変更。実装済み工程と将来の契約を各節で区別する                                 |
| [要件計画](requirement-planning.md)               | plan変更。送信profile・データ契約・再計画を確認する                                                    |
| [ソース入力](source-inputs.md)                    | sourceFiles変更・実機再評価。全文送信の許可と入力固定を確認する。個別WSL再開例は汎用の開発手順ではない |
| [公式CLI接続](official-cli.md)                    | Codex接続・認証委譲の変更。対応条件・権限制限・移行を確認する                                          |
| [隔離実行とレポート](isolated-execution.md)       | run変更。隔離・依存準備・通信・証拠・状態の契約と保証限界を確認する                                    |
| [注文API評価](order-api-evaluation.md)            | 製品品質の評価・接続の回帰確認。固定応答と実モデル、現行手順と過去の実測を区別する                     |

[注文API fixture](../fixtures/order-api/README.md) は製品評価用の入力と正解データです。開発ハーネスの能力評価とは分けます。

## 証拠・履歴として保持する資料

以下は通常作業の指示には不要です。比較・障害調査・受け入れ条件のレビュー時だけ参照します。記録されたrevisionと環境の証拠であり、現在の仕様・成功・Issueの状態を保証しません。失敗記録も、改善前後の比較に必要なので残します。

| 資料                                                                         | 保持理由                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------- |
| [初回記録](harness/runs/2026-10-25.md)                                       | ハーネス初回整備の条件・証拠・未実施事項           |
| [修正前後比較](harness/runs/2026-10-25-followup.md)                          | 環境診断の不具合と固定入力による比較の根拠         |
| [再開記録](harness/runs/2026-10-25-resume.md)                                | 別セッションでの再開経路と不足の根拠               |
| [環境診断比較JSON](harness/runs/environment-regression-2026-10-25.json)      | 修正前後のケース・trial・終了結果                  |
| [再開時の診断JSON](harness/runs/environment-resume-2026-10-25.json)          | 再開環境の診断結果。エージェント完了率には使わない |
| [旧HTTP固定応答](evaluations/order-api-fixed-2026-10-25.json)                | 廃止したHTTP接続時の製品回帰の比較基準             |
| [旧CLI固定応答](evaluations/order-api-cli-fixed-2026-10-26.json)             | 旧Claude接続時の製品回帰の比較基準                 |
| [Codex固定応答](evaluations/order-api-codex-fixed-2026-10-26.json)           | Codex接続の全工程回帰。実モデル品質の証拠とは区別  |
| [WSL起動検査](evaluations/wsl2-startup-2026-10-27.json)                      | WSL上の自動テスト・公式CLI起動の証拠               |
| [実plan失敗](evaluations/codex-real-attempt-2026-10-27.json)                 | 実モデル利用の初回失敗と取得不能情報               |
| [実plan・run失敗](evaluations/codex-real-plan-run-2026-10-27.json)           | 要件計画の成功と証拠ID重複によるrun失敗            |
| [実correctの誤検出](evaluations/codex-real-correct-run-2026-10-27.json)      | ソース入力改善前の誤検出の比較基準                 |
| [ソース入力後の実比較](evaluations/codex-real-source-inputs-2026-10-28.json) | correct/buggy比較、改善前の停止、残る品質課題      |

[旧開発fixture](../fixtures/ai-development/README.md) は旧横断検証の履歴です。現行の製品評価には注文API fixtureを使います。

## 維持のルール

設計判断は [ADR](adr/README.md)、Issue/PRの進捗・受け入れ確認・引き継ぎはIssue/PR本文・コメントに残します。Issue/PR単位のファイルと旧URL案内は廃止し、過去の内容はGit履歴で確認します。PR作成前に関連文書を更新する手順は [開発手順](development.md) を正本とします。

詳細の正本は上表の資料とし、README・AGENTS・連携指示は入口と必要な要約にします。新規文書は用途・正本・読む場面を決め、既存資料で足りるなら統合します。同じルール・進捗・実測を複製しません。仕様は「実装済み」「合意済み・未実装」「検討中」、履歴は対象revisionと当時の状態を示します。

文書を移す場合はリポジトリ内の参照先と索引を更新します。通常テストのリンク検査はGit管理・未追跡の非ignore Markdownのローカルファイル参照を確認します。外部URL・見出しアンカー・コマンドの意味や鮮度は保証外なので、関連変更のレビューで確認します。
