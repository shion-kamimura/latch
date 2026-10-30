# OpenCodeによる実装と通常PR CI

状態: 現行運用。全体の責務・保証の地図は [アーキテクチャ](../ARCHITECTURE.md)、設計基準は [ハーネス設計](adr/0002-minimal-development-harness.md) を参照してください。

設計判断は [ADR 0003](adr/0003-delegate-development-automation.md) を参照してください。

## 構成と有効化前の準備

#64の構成は、公式OpenCode GitHub ActionにIssue取得・実装・自己テスト・ブランチ・commit・通常PR作成とPR上の追加修正を任せます。検証結果は既存の `.github/workflows/ci.yml`、Checks、Actionsログに残します。独自のエージェントループ・publisher・本文レンダラー・PR作成前の独立検証器はありません。

管理者が以下を確認してから有効化します。この変更自体はAppのインストール、実権限・Secrets・課金設定の適用や有料試験を行いません。

1. [公式OpenCode GitHub App](https://github.com/apps/opencode-agent) を対象リポジトリに限定してインストールする。Appが要求する権限を確認し、コード読取・ブランチ/commit書込・Issueコメント・PR作成/更新が組織ポリシーで許可されることを確認する。workflow変更にはApp側の対応権限も必要で、不足時は人が引き継ぐ。自動承認・自動マージの権限や設定は追加しない。
2. Actions Secret `DEEPSEEK_API_KEY` を設定する。旧gateway向けSecretから自動コピーしない。DeepSeekで `deepseek-flash`（DeepSeek V4.1 Flash）を利用できること、API利用予算と停止方法を確認する。モデルは `deepseek/deepseek-flash`、OpenAI互換provider、`https://api.deepseek.com/v1`、出力8192・context 1,000,000を設定して旧モデルを継続する。別モデルへの自動フォールバックは行わない。API互換性・残高・モデル提供状況は実接続で別途確認する。
3. Node.js 26、packageManager指定のpnpm、GitHub-hosted `ubuntu-24.04`、npm・DeepSeek・OpenCode・GitHubへの通信が利用できることを確認する。Actions自体はNode.js 24 runtimeで動く版を使い、プロジェクトのNode.js 26とは区別する。base依存は `pnpm install --frozen-lockfile --ignore-scripts` とActionsのpnpm cacheで準備する。公式連携がPR headへ切り替えた後のfrozen installと自己テストはAIへ指示する。base準備とhead準備を混同しない。キャッシュhitは検証の証拠ではない。Action版と互換性の記録は [CI実行環境とGitHub Actionsの保守](ci.md) を参照する。
4. App経由の通常PRと追加commitから通常CIが動くことを、承認済みの試験予算で下記の実動確認手順に従って確認する。CIを要求するbranch protection / rulesetは管理者が別途設定・確認する。このPRでは変更しない。
5. Repository variable `OPENCODE_ENABLED=true` を設定するとコメント起動を有効化する。未設定・falseでは起動しない。これは管理者による切替用で、予算の承認や課金上限を代替しない。

## 起動・追加修正・結果の確認

write / maintain / adminの利用者が開いたIssueへ次を投稿します。

```text
/opencode このIssueの受け入れ条件に沿って実装してください
```

`/oc` も利用できます。コマンドは空白で区切り、小文字で記載してください。コマンドだけなら公式連携ではスレッド要約になるため、実装依頼を明記します。Issueの作成・編集、ラベル付与、CI失敗だけでは起動しません。

通常PRが作成されたら、最新commitのChecksでCIを確認します。CIはLint・型チェック・format・Unit/Integration・build・CLI E2Eを実行します。自己テストと通常CIは別の実行です。本文の「実行待ち／未確認」は作成時点の情報で、CI終了ごとに自動更新しません。ChecksとActions実行ログ、対象SHAが結果の根拠です。AIの説明や自己テスト成功だけで要件全体を検証済みとしません。

CI失敗やレビュー指摘の修正は、対象PRの会話または行コメントへ次のように依頼します。

```text
/oc 最新commitのCI失敗ログを確認し、原因を修正してください。実行した自己テストと未確認事項も報告してください
```

公式連携が同じPRへ追加commitし、通常CIが再実行されます。今回の起動対象は同一リポジトリの開いたPRに限定し、fork PRと閉じたPRは資格情報を渡す前に拒否します。人のcommitを保持し、force pushしません。競合・権限不足時は停止して人が対応します。新しいIssueコメントからの再依頼は新規ブランチ・PRになる可能性があるため、継続修正は既存PR上で依頼してください。旧Issue hashブランチやbot所有マーカーとの互換性は要求しません。

PRタイトル・本文・完了報告の共通規則は [開発手順](development.md) を正本とします。公式連携は最終回答を本文、追加の短い要約をタイトルに利用するため、両方に指示しています。LLM出力を構文保証する独自修正器はなく、fallbackタイトルや本文不足は人が確認し、PR上で修正を依頼します。新規PRは通常PR（draft=false）で、Draft変換・Ready操作は不要です。人がレビューし、自動承認・自動マージは行いません。

## 起動権限・認証・実行環境・ログ

資格情報を持たないauthorize jobが、コメント作成イベント・独立したコマンド・人間の投稿者を確認します。コメント投稿者、実行actor、再実行者 `GITHUB_TRIGGERING_ACTOR` の現在の権限をGitHub APIで照合し、write / maintain / admin以外や照合失敗を拒否します。author_associationだけでは許可しません。APIキー・App token・checkoutした候補コードはこのjobへ渡しません。公式連携自身も利用者権限を確認します。

implement jobだけに `id-token: write` を与え、OpenCodeのOIDC交換で公式App installation tokenを取得します。`use_github_token: false`、checkoutは `persist-credentials: false`。GitHub標準tokenにはcontents readだけを与え、App認証失敗時に標準tokenへ切り替えません。`GITHUB_TOKEN`で作成したPR・pushでは後続workflowが通常起動しないためです。App tokenで生成したPRと追加commitのCI起動は、組織ポリシーを含め実環境で確認する必要があります。

APIキーは存在確認ステップと公式Actionステップだけに渡し、依存準備ステップへ渡しません。ただし公式連携のプロセスと実装中のコマンドは同じrunner上で動き、キーとAppの書込能力に触れ得ます。旧gateway別コンテナによるキー隔離、read-only/non-rootコンテナ、通信宛先制限、CPU・メモリ・pids制限、候補と独立検証の分離は新構成にはありません。GitHub-hostedの実行ごとのVM分離を使い、self-hosted runnerには移しません。製品CLIの隔離実行要件をこの開発用構成へ読み替えません。

権限のある利用者からの実装依頼は非対話で進めるため、OpenCodeの `permission: "allow"` を設定し、ツール操作の追加確認を待ちません。`external_directory` による `/tmp` など作業ディレクトリ外へのアクセスや、`doom_loop` の既定の確認待ちも対象です。ツール操作の自動許可は、マージ・レビュー承認・Secretsや実権限・課金設定の変更を依頼範囲へ追加するものではありません。起動前の利用者権限照合と実装指示は維持します。公式GitHub handlerがセッションに設定する `question: deny` も維持されます。

公開セッション共有は `share: 'false'` とconfigの `share: disabled` で明示的に無効化します。採用Actionではshare入力は廃止済みですが、旧版の暗黙共有を避ける意図を保持します。共有を廃止したCLIでもActionsログとGitHubへの回答・コード公開は残ります。環境全体・キー・認証ヘッダーを出力せず、debug loggingを有効化しません。独自の生ログ・session・proposal artifactは保存しません。Actions標準ログとcacheの保存期間・削除、リポジトリの公開範囲はGitHub設定で管理し、Secretsのマスクがすべての漏えいを防ぐとは扱いません。漏えい時は実行停止、キー/token失効、ログ削除と監査を管理者が行います。

## 時間・費用・停止・再依頼

実装jobと権限照合jobにリポジトリ独自の短いtimeoutは設定しません。GitHub Actionsの既定のjob timeout（360分）とサービス側の実行上限は適用され、無期限の実行ではありません。

concurrencyは認可済みのimplement jobだけに設定し、Issue依頼・PR会話コメント・行コメントを共通の `opencode-${{ github.repository }}` グループで直列化します。リポジトリ全体で実装は同時に1件です。authorize jobはこのキューを使わず、botのPR作成通知、コマンドのないコメント、権限不足・対象外のIssue/PRなどの不許可イベントはimplement jobへ進みません。資格情報もimplement jobだけに渡します。

`cancel-in-progress: false` で実行中の作業を新コメントによって中断せず、`queue: max` で最大100件の実装jobを待機させます。上限内の待機依頼は後続の依頼で置換されません。満杯時は追加のjobがキャンセルされます。[GitHub公式の順序仕様](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) は、concurrencyグループで待機し始めた時点を基準とするFIFOです。認可jobの所要時間やjobの開始時刻は変わるため、コメント投稿順・workflow起動順の厳密なFIFOは保証しません。独自のキュー保存・dispatcher・定期ポーリング・重複排除・自動再試行は追加しません。

待機・失敗・キャンセルはActionsのOpenCode一覧から該当コメントの実行を開き、authorize / implement各jobの状態とログを確認します。キュー満杯などでキャンセルされた依頼は自動再投入されません。元コメント、実行URL、既存PR・途中成果を確認し、実行中・待機中の同じ依頼がないこととキューに空きができたことを確認してから、新しい `/oc` または `/opencode` コメントで再依頼します。既存PRがあればそのPRへ、なければ元のIssueへ投稿してください。設定変更後の確認にはmain反映後の新しいコメントを使い、元のworkflow revisionを使う古い実行の再実行と区別します。

旧gatewayの既定5 USD予約上限・要求数・通信量・tokenizer計測・usage精算は廃止します。Actions timeoutや8192出力設定はAPI請求額の厳密な上限ではありません。複数API要求や終了時の未精算があるため、管理者はDeepSeek側の利用可能な残高・利用制限と監視、GitHub Actionsの予算・使用量を確認してから有効化します。利用可能なproviderの強制上限がない場合は厳密な上限なしと認識し、承認済みの少額予算内で監視する必要があります。

停止はActions実行のCancel、緊急時はworkflow無効化または `OPENCODE_ENABLED=false`、必要に応じAppアクセス・DeepSeekキーの失効で行います。変数変更だけでは既に実行中のjobは止まらないためCancelも行います。停止しても送信済みAPI分の費用は取り消せません。

失敗時はまずログを確認します。App/OIDC、モデル、認証、依存取得の不足は成功と扱わず、設定を管理者が直してから新しいコメントで再依頼します。既存PRがあればそのPRへ依頼します。CIだけの一時失敗はActionsの再実行で確認でき、有料AIの再起動を必須にしません。無人修復ループ、CIポーリング、CI結果の本文自動同期はありません。

### 許可待ちによる停止と再依頼

[実行40097478100のattempt 2](https://github.com/shion-kamimura/latch/actions/runs/40097478100/attempts/2) では、OpenCodeが `/tmp/correct.patch` と `/tmp/buggy.patch` を扱う際に `external_directory` の既定値 `ask` で止まり、約27分待機した後に旧30分timeoutでキャンセルされました。モデルの要求数や費用上限による停止ではありません。`permission: "allow"` はこの非対話の確認待ちを解消し、短いtimeoutの撤去だけで待ち続ける状態にしないための設定です。

修正をmainへ反映後、新しい `/oc` または `/opencode` コメントで再依頼してください。古い実行の再実行は元のworkflow revisionを使うため、変更後の設定が使われるとは扱いません。既存PRがあればそのPRへ、まだPRがなければ元のIssueへ依頼します。

## 移行と切り戻し

1. 旧 `issue-draft-pr.yml` の実行・待機があれば管理者が停止し、途中成果と既存PRを個別確認する。#62をこの移行だけで変更・マージ・クローズしない。既存Draftを一括変換しない。
2. レビュー後にこの変更をmainへマージする。旧workflow、`.github/automation/`、旧専用チェックを同時に削除し、通常運用を旧prepare/run/publish・proposal schemaへ依存させない。
3. 上記準備を済ませ、承認済み試験で動作確認する。不要になった旧Secrets・artifact/cacheは管理者が保存方針を確認して整理する。コードの削除だけでは既存データやSecretは消えない。
4. 問題時は新workflowを無効化して実行をCancelする。既存PRは保持し、手動開発＋通常CIを使う。旧構成へ戻す必要がある場合はこの移行commitをrevertするレビュー付きPRを作り、旧実行環境・Secrets・費用上限を再点検してから有効化する。新旧を同時稼働せず、新成果を旧publisherに渡さない。他人のブランチを上書きしない。

## 確認した資料と残る実動確認

2026-10-24に公式[GitHub連携文書](https://opencode.ai/docs/github/)、[v1.19.4 Action](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/github/action.yml)、同版の [GitHub handler](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/cli/cmd/github.handler.ts) を確認しました。Actionは完全SHA固定ですが、内側でlatest releaseを調べ、公式installスクリプトからCLIを取得します。CLI本体・内側のAction参照まで固定した構成ではありません。`autoupdate: false` はこの初回取得を固定しません。版更新時や再有効化時には実際のCLI版をログで記録し、この互換性を再確認します。

リポジトリ内の試験は起動権限・コマンド・PR境界をモック検証し、concurrencyの配置・設定値・認可条件による除外と開発チェックを確認します。ローカル試験はGitHub側のキュー動作を実証するものではありません。複数依頼の実キュー保持・直列実行、実DeepSeek接続、Appインストール・OIDC、実モデルのPR本文/タイトル品質、botによる通常PR作成・追加commitからのCI連動は未検証です。未設定や予算未承認を完了済みとしません。管理者が承認した予算・環境で以下を確認し、実行URLとSHAを記録してください。

- 小さい試験Issueで実装依頼 → 新規PRの `draft=false`、タイトル、6見出し、自己テストとCI待ちの区別を確認する。
- そのApp作成PRの最新SHAで通常CIが起動し、ChecksとActionsログで結果を確認する。
- PR上の修正依頼 → 同じPRに追加commit → そのSHAで通常CI再実行、人の変更保持を確認する。
- 権限不足の利用者、未設定キー、App失敗が実装成功と扱われないこと、共有リンクが作成されないことを確認する。
- CI失敗だけではAIが再起動しないこととCancel/無効化の停止手順を確認する。
- 1件の実装中に2件以上の有効な依頼とbot通知を発生させ、有効な依頼のimplement jobが待機し続け、bot通知ではimplement jobがスキップされることを確認する。待機依頼が置換されず、実装が1件ずつ進むことを各実行URLで記録する。有料実行は承認済み予算内に限る。
