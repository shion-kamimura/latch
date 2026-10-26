# ドキュメント索引

必要な資料から読み始めてください。実装状況の入口は [README](../README.md)、コードの責務は [アーキテクチャ](../ARCHITECTURE.md) です。

| 資料                                               | 役割・状態                                                  |
| -------------------------------------------------- | ----------------------------------------------------------- |
| [製品方針](product-vision.md)                      | 現行の目的・MVP方針。構想・未決定事項を含む                 |
| [公式CLIへの移行調査](official-cli.md)             | #81の比較・未採用の理由・再開条件。接続置換は未実装         |
| [PR前検証の利用仕様](pre-pr-verification.md)       | 実装済み工程と将来の入出力契約。各節の状態を確認する        |
| [要件計画](requirement-planning.md)                | 実装済みのplan・送信profile・データ契約。実API品質は未評価  |
| [隔離実行とレポート](isolated-execution.md)        | 実装済みのrunと制約。悪意あるコードの完全な封じ込めは未検証 |
| [開発手順](development.md)                         | 環境準備、実装、検証、PR規則の正本                          |
| [Issue設計](issue-design.md)                       | 要件整理・登録・ラベル選択の正本                            |
| [OpenCode運用](opencode.md)                        | 現行サービスの起動、権限、費用、停止・再依頼の正本          |
| [ハーネス設計](harness/design.md)                  | 一次資料に基づく原則と採用理由                              |
| [評価手順](harness/evaluation.md)                  | 代表ケース、採点、記録方法。定義と実施済みを区別            |
| [進行計画](harness/plan.md)                        | #76の段階、進捗、再開方法                                   |
| [初回記録](harness/runs/2026-10-25.md)             | この整備の条件・証拠・未検証事項                            |
| [注文API fixture](../fixtures/order-api/README.md) | 製品評価用の入力と正解データ                                |

## 履歴資料

開発ハーネスの継続記録: [環境診断の修正前後比較](harness/runs/2026-10-25-followup.md)。固定入力の比較と、エージェントの独立評価を区別します。

- [旧Issue to Draft PR](issue-draft-pr.md): 廃止済み。現行手順ではない。
- [自動化の委譲・移行記録](automation-delegation.md): #64時点の責務置換。Issueの状態は最新GitHubで確認する。
- [旧検証記録](ai-development-validation.md)、[旧開発fixture](../fixtures/ai-development/README.md): 当時のrevisionの記録。現行構成の保証には使わない。

## 維持のルール

詳細の正本は上表の資料とし、README・AGENTS・連携指示は入口と必要な要約にする。仕様は「実装済み」「合意済み・未実装」「検討中」、履歴は「廃止済み」と明示する。機能変更時はコード・仕様・READMEを同じ変更で整合させる。

文書を移す場合は参照先と必要な旧URL案内を更新する。通常テストのリンク検査はGit管理・未追跡の非ignore Markdownのローカルファイル参照を確認する。外部URL・見出しアンカー・コマンドの意味や鮮度は保証外なので、関連変更のレビューで確認する。
