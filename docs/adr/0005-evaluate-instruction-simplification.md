# ADR 0005: 指示を正本へ集約し実運用の組み合わせで評価する

状態: 採用。日付: 2026-10-30。実モデルによる改善効果は未測定。

## 背景

共通ルール・開発手順・OpenCode指示に同じ規則が重複し、一律の文書読込や全チェックが小さな作業にも適用される余地があった。従来の評価はチャット上の自己試行と環境診断の固定入力比較が中心で、実OpenCode＋DeepSeekの成果を代替できない。

## 決定

[ADR 0002](0002-minimal-development-harness.md) の最小構成を維持し、AGENTSは共通の境界と作業別の入口、開発手順は準備・検証・PR・再開の正本、OpenCode指示は連携固有の差分に限定する。資料読込と検証は変更の影響に応じて選び、PR前の関連文書更新と重要な権限・秘密・人の変更保護の制約は維持する。

ローカル検査、チャットの自己試行、実OpenCode連携を区別する。実運用のモデル・CLI・指示・runnerを識別し、変更前後で同じ課題を比較する。正常終了、要件充足、環境停止、介入、時間・費用を分け、失敗も分母と費用に含める。手順は [ハーネス評価](../harness/evaluation.md) を正本とする。

今回は比較評価の準備までとし、有料実行・新しいコメント起動・権限やSecretsの変更はしない。モデルに固有の助言はDeepSeekへ無条件に転用せず、実測で採否を決める。指示削減の効果を確認するための独自エージェントループや自動評価サービスは追加しない。

## 検討した代替案

- 同じ指示を各入口へ複製する: 常時文脈と更新漏れが増えるため、連携固有の差分だけを残す。
- 新しいスキル・複数エージェント・強制コンテキストリセットを先に追加する: 実運用での不足と効果が未測定なので採らない。
- 固定応答やチャットの成功だけで採用効果を判断する: 実ハーネスの認証・ツール・モデル・PR連動を測れないため採らない。

## 影響

常時読む指示と重複を減らせる一方、正本を必要時に参照できることが前提になる。PR前の文書更新・中断再開・小さな修正を評価ケースに含め、取りこぼしがあれば削減を見直す。CLIのlatest取得など条件を固定できない場合、指示だけの効果とは断定しない。実運用の比較には別途試験先と予算が必要。

## 根拠と関連資料

2026-10-30確認。公式事例と研究の観測を一般的な性能保証として扱わない。

- OpenAI, [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)（2026-09-11）: 過剰な指示と常時読込を見直し、必要時に詳細へ進む。GPT-6 Astra向けの助言はモデル依存。
- OpenAI/deepsense.ai, [Harness-aware evaluation of plugins](https://developers.openai.com/cookbook/examples/partners/harness_aware_plugin_evals/harness_aware_plugin_evals)（2026-09-23）: 単体と製品ハーネスでは評価対象が異なる。pluginの事例を開発連携の層分けに応用する。
- [When Agents Fail: Model or Harness—Who's to Blame?](https://arxiv.org/abs/2610.32483)（2026-10-23、査読中）: モデルとハーネスの組み合わせ、正常完了と正しさ、失敗を含むtoken負荷を区別する。報告された順位を本repoの選定理由にしない。
- Anthropic, [Scaling Managed Agents](https://www.anthropic.com/research/managed-agents)（2026-04-08）: モデルが進歩したらハーネスに埋め込んだ前提も再検討する。
