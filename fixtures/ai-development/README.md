# 開発自動化の横断確認fixture

#32の旧パス制限が解消したことを、小さな依存不要のDuration API、設定・lockfile、正しい差分・不具合差分で確認します。#22の製品評価用fixture全体の完成を意味しません。Latch CLI検証機能や実LLMを使いません。

`api/`と`issue.md`を入力側とし、`evaluation/`の正解データは入力へ混ぜません。correct.patchはすべての負数を拒否し、buggy.patchは-1だけを拒否します。どちらも既存テストを通りますが、独立した期待値ではbuggyの-2が不一致になります。

## 状態: 旧構成の履歴

#64で `.github/automation/` とこのfixtureを使うPython横断テストは削除されました。旧コマンドは現在実行できません。当時の結果・revisionは [旧検証記録](../../docs/archive/ai-development-validation.md) を参照してください。

現行の製品評価には [注文API fixture](../order-api/README.md)、開発ハーネスの確認には [評価手順](../../docs/harness/evaluation.md) を使います。このfixtureを残していることは、現行の実LLM・Docker・元実行39779457307を再現できる保証ではありません。
