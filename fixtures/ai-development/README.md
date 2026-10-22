# 開発自動化の横断確認fixture

#32の旧パス制限が解消したことを、小さな依存不要のDuration API、設定・lockfile、正しい差分・不具合差分で確認します。#22の製品評価用fixture全体の完成を意味しません。Latch CLI検証機能や実LLMを使いません。

`api/`と`issue.md`を入力側とし、`evaluation/`の正解データは入力へ混ぜません。correct.patchはすべての負数を拒否し、buggy.patchは-1だけを拒否します。どちらも既存テストを通りますが、独立した期待値ではbuggyの-2が不一致になります。

Pythonの横断テストは、これらを一時領域へコピーして差分適用とデータ検査を行います。Nodeがある環境では `node --test` で既存テストを確認し、別プロセスの評価で期待値と照合します。外部接続、課金、GitHub書き込みは行いません。

```sh
python3 -B -m unittest discover -s .github/automation -p 'test_parent_acceptance.py' -v
```

実Dockerの依存取得・悪意あるinstall scriptの隔離、OpenCodeモックは別に確認が必要です。元実行39779457307の具体的な拒否ファイルは未特定で、このfixtureによる再現済みとは扱いません。
