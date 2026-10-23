# 自動実装の責務と標準機能への委譲

## 決定と適用範囲

2026-10-23、Issue #53の設計記録。確認したコードはmain `5512bd712d628bf9e0bc737675ccaff66c107824`。当面の既定構成は **OpenCode + pnpm + GitHub Actions + 既存の境界制御** とする。新規有料サービス・常駐サーバー・外部アカウントを必須にしない。標準機能に処理を任せ、信頼・費用・公開の判断だけを独自コードに残す。

これは後続実装の契約であり、キャッシュ、検証のみの再実行、修復ループの実装完了を示さない。今回変更するのは文書だけで、CLI、workflow、権限、Secrets、PR #52の候補は変更しない。複数エージェント製品の切替層も先行実装しない。

## 現状と判断

| 責務            | 現行実装                                                           | 候補と決定                                                                    | 理由・残す独自コード                                                                                            |
| --------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Issue入力・起動 | `prepare.mjs`、`policy.py`、prepare job                            | 薄い接続を残す。Actions dispatch / github-scriptへ取得を委譲                  | 実行者・再実行者の権限、Issue node ID、固定base / source、観測先端、分岐選択はLatch固有                         |
| AI実装          | `Dockerfile`、`run.py`、`agent_metrics.py`                         | OpenCode CLIへ委譲済み、継続採用                                              | 探索・編集・ツール反復を再実装しない。入力生成、終了分類、安全な計測だけを接続として残す                        |
| 実行管理        | `issue-draft-pr.yml`、`run.py`                                     | Actionsのjobs / needs / concurrency / timeoutと将来の再利用可能workflowへ委譲 | 独自スケジューラは作らない。非root、read-only、capability除去、internal network、停止・回収は独自制御を維持     |
| 依存準備        | `prepare_dependencies()`、`registry.py`                            | pnpm install / fetchとActions cacheを優先（#55）。薄い起動・診断を残す        | frozen lockfile照合、取得とscript実行の分離、候補ごとの再構築を維持。fetchだけでinstallを代替しない             |
| 独立検証        | `independent_check()`、`automation_command()`                      | pnpm scripts / 既存テストランナーへ実行を委譲済み。#56で独立jobへ             | チェック選択、固定制御、候補との分離、hash照合、状態集約は残す。ホスト実行へ移さない                            |
| 成果・診断保存  | `save_proposal()`、`write_diagnostics()`、upload/download-artifact | Actions Artifactを継続採用。#54 / #56で保存データを拡張                       | 独自ストレージを作らない。スキーマ、サイズ・秘密情報・パス検査、sourceとの結合は残す                            |
| PR公開          | `publish.py`、`policy.py`、publish job                             | 既存Git APIを当面維持。gh / create-pull-requestは今回は不採用                 | 下記の所有権・競合・再試行契約を置換だけでは省略できず、追加依存による簡素化がまだ示せない                      |
| API中継         | `gateway.py`、`Dockerfile.gateway`                                 | 独自制御を維持。OpenCode直結・LiteLLM置換は保留                               | キー隔離、送信先固定、予約・欠測精算の同等性が未確認（下表）                                                    |
| npm通信境界     | `registry.py`、別internal network                                  | 独自の固定宛先CONNECTを維持。キャッシュはpnpmへ                               | pnpm設定だけはネットワーク境界にならない。Verdaccioはpackage registryであり、必要なトンネル境界の代替確認が不足 |

[Actions再利用可能workflow](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) は `workflow_call` でjobsを共通化できる。#56で検証経路が二つになった時点で抽出する。呼び出すworkflowは信頼したbaseの定義を使い、候補workflowを実行せず、Secretsの包括継承を避ける。現在の単一経路を分割するだけの抽象化は行わない。

### pnpmとキャッシュ

[pnpm fetch](https://pnpm.io/cli/fetch) はlockfileから事前取得する候補、[Actions cache](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) は再取得を減らす保存手段として採用する。#55ではコンテナのstoreだけを受け渡し、候補由来の設定やinstall scriptをホストで動かさない。`node_modules`、ビルド成果物、秘密情報は共有しない。

キャッシュkeyはOS・architecture・Node/pnpm・信頼したimage・lockfile・依存設定のdigestを含める。同一keyでもキャッシュを検証証拠とせず、候補のmanifest / lockfileに対してfrozen installを行う。候補が書けるstoreを信頼した制御や別の信頼領域の保存keyへ昇格させない。最初は完全一致のみ、取り出したコピーを使い、miss・破損・削除時は隔離されたregistry取得へ戻す。cacheなしでも動くことを必須とする。

`fetch → install --offline --frozen-lockfile --ignore-scripts → network noneでrebuild` は#55で比較する構成案で、現行は直接installである。file依存、patch、workspace、設定変更を含めて比較し、fetchがmanifest整合やscript準備を保証するとは扱わない。baseの事前準備に成功しても、AIが依存を変更した候補は独立して準備する。

### 公開の選択

[gh pr create](https://cli.github.com/manual/gh_pr_create) はDraft作成・本文ファイル指定に使えるが、Git treeのmode / binary / symlink処理や観測先端の保護は別途必要。[create-pull-request](https://github.com/peter-evans/create-pull-request) はworkspace差分のcommitとPR更新を委譲できるが、既存のJSON提案公開方式からの移行、bot所有記録、人間コミット、閉じたPR履歴との整合確認が増える。両者とも今回は導入しない。将来、境界テストを同じ結果で通し、保守するコードが減ることを示せた場合に再評価する。

公開は別runnerだけがcontents / pull-requests writeを持ち、候補をコードとして実行しない。node ID、bot所有marker、生成commit、観測先端を照合する。sourceの子commitを非forceで更新し、先端変化や人間変更は上書きしない。要求変更・終了時はRefsにし、最新要求の充足を主張しない。branch作成後のPR API失敗は同一proposal IDで回復し、並行作成は再照会する。Actions concurrencyだけを競合防止の根拠にしない。GITHUB_TOKEN作成PRから通常CIが起動しない制約も残る。

## OpenCodeの入出力契約と状態

[公式CLI](https://opencode.ai/docs/cli/) の `run --format json` を現行接続に使う。以下は現行のrequest / proposalを基にした後続の共通契約であり、新しいスキーマが既に実装済みという意味ではない。

| 境界           | データ・規則                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 信頼した入力   | requestのIssue number / node_id / title / body、制御base、固定source、branch、expected_head。制御はbaseから取得。sourceは既存Draft先端になる場合もあり、候補として扱う     |
| AIへの入力     | read-onlyのIssue snapshot、sourceの作業コピー、信頼したプロンプト、固定モデル・接続設定、費用5 USD・AI60分と資源上限。Issue文字列はデータとして渡しシェルへ展開しない      |
| AIへの権限     | 作業コピーのみ変更可。GitHub token・実APIキー・Docker socket・ホストhomeなし。APIはgateway、依存はregistry経由。実装中のテスト結果は自己申告として扱う                     |
| AI出力         | 変更ファイル、`dist/latch-pr-title.json`、終了コード、JSONイベントから許可した計測。通常終了を現行 `implementation=completed` に写しても、要件充足・検証成功とは表示しない |
| ホストでの確定 | AI停止後にsnapshotし、path / mode / size / secret / titleを検査。現行proposal schema 2のfiles / checks / implementation / pr_titleへ保存。生イベントをそのまま公開しない   |
| 検証出力       | 各checkのstatus / exit_code / reason、候補digest、依存準備の段階・時間・安全なログ（後者は#54 / #56）。検証後のsource変更は拒否                                            |
| 公開入力       | requestと安全なproposal。候補識別子・検証対象・実行IDを照合し、公開時にも再検査。artifactの名前やAIの成功宣言を信頼根拠にしない                                            |

```text
prepare → 固定入力 → AI実装 → 停止・候補安全検査 → 独立依存準備 → 独立チェック
                         ↓                    ↓                 ↓
                 安全な部分成果         準備失敗・判定不能     成功 / 失敗 / 未実行
                         └────────── 成果・診断保存 ──────────────┘
                                          ↓
                           公開再検査 → Draft作成・更新 / 競合停止
```

現行 `proposal_ready` は実行したチェックの成功、`partial_proposal` は安全な変更と不完全な実行結果、`no_changes` は差分なしであり、いずれもIssue全体の意味的な充足判定ではない。各checkはpassed / failed / timeout / environment_unavailable / not_runを分ける。`covered_by_test` はbuildを含む固定test scriptを確認した場合だけ使用する。安全検査不合格・不正タイトルは公開しない。安全な部分成果でも未実行を成功に繰り上げない。

#56の検証のみの再実行は、保存候補のdigest、元request、制御base、tool image、検証ポリシー、元run / attemptを記録し、APIキーなしで新しい検証結果を作る。別候補への結果流用、最新mainへの黙示的な載せ替えは拒否する。#57の修復でsourceが変われば新しい候補として全必要チェックを再実行する。

## API gateway / registry proxyの採否

[OpenCode permissions](https://opencode.ai/docs/permissions/) はツール操作のallow / ask / denyを設定できるが、候補のshell通信まで含むホストの強制境界の代用とは判断しない。[LiteLLMの予算・rate limit](https://docs.litellm.ai/docs/proxy/users) と [Verdaccioのpackage access](https://verdaccio.org/docs/protect-your-dependencies/) を比較した。仕様の記載が見つからないことは「機能が存在しない」証明ではなく、以下は採用に必要な同等性が未確認という判断である。

| 必要機能                     | 現行                                                          | 外部機能との対応・決定                                                                                      |
| ---------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 実キーを候補へ渡さない       | gatewayだけがキーを保持                                       | OpenCode直結では候補プロセスの資格情報になる。LiteLLM別コンテナ + virtual keyは候補だが配置・権限試験が必要 |
| 送信先・モデル・redirect制限 | gatewayの固定DeepSeek宛先、モデル検査                         | provider設定だけでは任意URL・redirect拒否の同等性を未確認。外側のegress制御も必要                           |
| 送信前費用予約・並行予約     | tokenizer / 同一要求usage / 最大contextで予約                 | LiteLLMにbudget設定はあるが、現行の未精算予約・cache hit/miss・欠測時の扱いと一致するか未確認               |
| 時間・サイズ・反復上限       | host timeout、gatewayの要求数・サイズ上限                     | Actions timeoutは実行時間に使える。通信単位の制限まで代替したとは扱わない                                   |
| 送信後timeout / usage欠測    | 不明額を保持し、過少計測を停止                                | 外部gatewayの同等動作は未試験。観測できない請求を0として再試行しない                                        |
| registry限定、キーなし       | `registry.npmjs.org:443`だけCONNECT、16接続・各5分・総512 MiB | pnpm registry指定は任意通信を防がない。Verdaccioのpackage権限・uplinkはCONNECT宛先制限の代替確認にならない  |
| lockfile URLを変えない       | TLSトンネルでmetadata・URLを維持                              | registry置換には既存lockfile、tarball URL、別host依存の拒否試験が必要。今回は維持                           |

外部gatewayは自己ホストでも更新・設定・場合によるDB管理が増える。全項目の境界試験と保守費低減が示されるまでは既存の小さな中継を残す。pnpmキャッシュは通信量を減らすが、通信制限を撤廃する理由にはしない。

## 保守・ライセンス・固定・復旧

2026-10-23に公式文書・公式リポジトリとLICENSEを確認した。文書は現行版であり、固定した古いバイナリの全機能を保証しない。最新releaseの安全性、全依存の監査、実接続互換性は未確認。単なるstar数を保守性の判定にしない。

| 委譲先                        | 保守主体・ライセンス                                                                                                                                   | 固定・必要権限・復旧方針                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode                      | anomalyco、[MIT](https://github.com/anomalyco/opencode/blob/dev/LICENSE)                                                                               | 現行1.19.3、Node26.12.0 / pnpm12.14.0。GitHub writeなし。更新PRでstartup・JSON計測・mock APIを試験し、旧imageへ戻せるよう記録                            |
| pnpm                          | pnpm、[MIT](https://github.com/pnpm/pnpm/blob/main/LICENSE)                                                                                            | packageManagerとimageの12.14.0を一致させる。lockfileとstore互換試験後に更新。失敗時はcache破棄・旧版で隔離再取得                                         |
| Actions cache / Artifact      | GitHub、[cache MIT](https://github.com/actions/cache/blob/main/LICENSE) / [Artifact MIT](https://github.com/actions/upload-artifact/blob/main/LICENSE) | 現行Artifact v4。新規cache導入・Action更新時はreviewした完全commit SHAとrunner互換性を記録。独自PR write権限不要。保存失敗・期限切れを判定不能として明示 |
| Actions再利用workflow         | GitHubサービスの利用条件、リポジトリ内の定義                                                                                                           | 信頼したrevisionを固定しread権限を既定にする。writeはpublishのみ。旧workflowへrevert可能な分割PRにする                                                   |
| GitHub CLI（未採用）          | GitHub、[MIT](https://github.com/cli/cli/blob/trunk/LICENSE)                                                                                           | 導入時は版・配布checksumを固定。write tokenはpublishのみ。API失敗でforce pushしない。旧publisherへ戻す                                                   |
| create-pull-request（未採用） | peter-evans、[MIT](https://github.com/peter-evans/create-pull-request/blob/main/LICENSE)                                                               | 導入するなら完全SHA固定、contents / PR writeをpublishだけへ。branch更新挙動の回帰確認が条件                                                              |
| LiteLLM（未採用）             | BerriAI、[MIT部分とenterprise別ライセンス](https://github.com/BerriAI/litellm/blob/main/LICENSE)                                                       | 導入候補版・image digest未選定。必要機能の無償版含有・DB要否を確認するまで依存に追加しない                                                               |
| Verdaccio（未採用）           | Verdaccio contributors、[MIT](https://github.com/verdaccio/verdaccio/blob/master/LICENSE)                                                              | 導入版未選定。保存領域・uplink管理が増えるため今回は追加しない                                                                                           |

保守状況の確認先は [OpenCode releases](https://github.com/anomalyco/opencode/releases)、[pnpm releases](https://github.com/pnpm/pnpm/releases)、[Artifact releases](https://github.com/actions/upload-artifact/releases)、[gh releases](https://github.com/cli/cli/releases)、[create-pull-request releases](https://github.com/peter-evans/create-pull-request/releases)、[LiteLLM releases](https://github.com/BerriAI/litellm/releases)、[Verdaccio releases](https://github.com/verdaccio/verdaccio/releases)。公開された更新履歴を確認でき、置換候補としての保守窓口は追跡可能と評価した。ただし継続保守の保証や現行固定版への修正提供の保証はない。cacheのrelease一覧は今回取得できず、公式README・LICENSEまでの確認に留まる。導入時にrelease・runner要件の再確認を必須とする。第三者Action・gatewayへの置換は、標準機能より監視する更新元を増やす点も不採用理由に含める。

採用済みツールは各移行PRでrelease履歴・security advisory・最低runner要件・LICENSE変更を再確認し、バージョン変更と動作差分をレビューする。現行Actionのmajor tagやDocker tagは完全に不変ではないため、完全SHA / image digestへの強化は後続の実装差分で扱い、今回固定済みと主張しない。

## 費用と保存期間

新規ライセンス料金・有料SaaS契約・常駐基盤の固定費は要求しない。既存のLLM API従量費、Actions実行時間、Artifact・cache保存量は別である。[GitHub料金仕様](https://docs.github.com/en/billing/concepts/product-billing/github-actions) はpublicの標準hosted runnerとprivateのプラン枠を区別している。無料枠を恒久・無制限と扱わず、利用時のプラン・課金画面で確認する。ここでは新たな予算や課金設定を適用しない。

現行のAPI推定停止は1実行5 USD / AI60分、implement job90分。再実行すれば別の費用が発生し、推定停止は請求額の厳密保証ではない。現行診断のtokens・推定額・未精算予約・AI時間を残す。#54以降は依存 / scripts / checksの時間、cache hit/miss、artifact bytesも記録し、Actionsの実課金は管理画面と照合する。cacheは取得時間を減らす一方で保存費を生み得る。

現行workflowのIssue request / proposalは1日、diagnostics / policyは14日保存。#56では検証再実行用の安全な候補・manifestも既定1日とし、長期化は容量と機密性を評価した別変更にする。cacheは再生成可能な性能改善に限り、GitHubの保持・eviction規則に従う。runner強制終了時は `always()` でも保存できない場合がある。期限切れ・欠損なら同一候補の再現不能と表示し、AIを無断で再起動しない。

## 実行 #12からの不足と移行順

[実行39957670130（#12）](https://github.com/shion-kamimura/latch/actions/runs/39957670130) のjob一覧と [Draft PR #52](https://github.com/shion-kamimura/latch/pull/52) を確認した。prepare / publish成功、implement失敗。PR本文は `implementation=completed`、dependenciesが `environment_unavailable / validation_timeout`、主要5チェックはnot_run。正常なプロセス終了と検証成功が別である実例である。約40分というAI処理時間はIssue #53の調査記録による。今回取得したjob一覧・PR本文だけでは依存取得とscriptのどちらがtimeoutしたか確定しない。

| 順序               | 担当・実装済みとの差分                                                                                               | 評価と切り戻し                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. #54（先行可能） | #36のdiagnostics / 部分成果保存を拡張。fetch・script・check別に開始 / 終了 / timeout、安全な末尾ログ、次の操作を保存 | 意図的な各段階失敗でログを照合。ログ上限・秘匿試験。問題時は追加ログを停止し既存診断を維持                                                              |
| 2. #55             | #35の隔離依存準備を維持し、AI前preflightとpnpm / cacheを導入                                                         | cold / warm / cacheなし、lockfile変更、不整合、script失敗を比較。時間・取得量・API再消費を計測。cache無効で現行隔離installへ戻す                        |
| 3. #56             | #36の成果保存、#37の公開冪等性を利用しAIと検証を分離。候補の検証のみ再実行                                           | 同一digestでAPI呼出0、期限切れ・改ざん・別source拒否、publish再試行と人間先端保護を確認。旧一体経路を残す間は新形式を黙って旧形式として解釈しない       |
| 4. #57             | #55 / #56の契約確定後、OpenCodeへ安全な検証失敗を返す修復ループ                                                      | 回数・残時間・残予算を信頼側で上限設定。環境不能は修復と区別し無駄なAPI再試行を避ける。改善・悪化・上限停止・各候補保存を評価。修復無効で一回実装へ戻す |

#35〜#38の実装は既にコードに存在する。#35の隔離準備、#36の部分成果、#37の所有権と再実行、#38の費用予約を未実装として作り直さない。履歴とモック確認範囲は [#32検証記録](ai-development-validation.md) を参照し、今回後続の不足と区別する。#41のタイトル契約も維持する。#51の `allow_maintenance` 削除は独立Issueであり、今回workflowや互換処理を変更しない。

各移行は別PRで受け入れ条件と計測結果をレビューする。旧制御revisionとartifact schemaを記録し、壊れた新経路は無効化またはrevertする。切り戻しても候補をホストで実行せず、上限を緩めず、他人のbranchを上書きしない。新しいschemaのartifactを旧publisherへ流さず、対応する信頼した制御で再検証する。

## 検証方針と残る確認

この設計でコードの挙動は変えないため、文言を固定するだけのテストは追加しない。文書整合・リンク、規定Node / pnpmチェックと既存Python境界・Node prepare試験を実行し、実行結果はPRに記録する。後続の制御コード変更では該当Python境界・統合試験に加え、必要な実Docker / OpenCodeモックを行う。

今回の公式仕様調査とローカル試験は、実Actionsでのcache hit・artifact復元、外部proxyの同等性、実DeepSeek課金・品質評価の証拠ではない。これらは各後続Issueの実環境評価として残る。保存した候補の検証だけを再実行する利用手順は#56完了後に運用文書へ追加する。
