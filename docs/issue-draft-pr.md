# IssueからDraft PRを作成する

GitHub Actionsの **Issue to Draft PR** を手動実行すると、指定したIssueをOpenCodeとDeepSeekで実装し、独立した検証に成功した変更からDraft PRを作成します。自動レビュー・自動マージは行いません。Latch CLI本体とは独立した開発用の自動化です。

## 初期設定

1. このワークフローをレビューしてmainにマージします。main以外からの手動実行は拒否します。
2. Repository Secret `DEEPSEEK_API_KEY` を設定します。既存のキーを使用でき、PATの追加は不要です。キーをIssue・ソース・Actions変数に書かないでください。
3. Settings → Actions → General → Workflow permissionsで **Allow GitHub Actions to create and approve pull requests** を有効にします。この実装はPR作成だけを使用し、承認操作は行いません。組織ポリシーで禁止されている場合は管理者による設定が必要です。
4. GitHub-hosted Ubuntu runnerからDocker Hub、npm registry、GitHub、DeepSeek APIへの通信が必要です。self-hosted runnerは想定していません。

## 実行

1. 対象Issueの目的・スコープ・受け入れ条件をレビューします。第三者のIssueも入力できるため、本文の内容を確認してから実行してください。
2. 自動化・開発ルール自体の変更が必要なIssueでは、変更対象と権限への影響をレビューします。実行時の `allow_maintenance` を明示的に有効にした場合だけ、下記の保守変更を提案できます。Issue本文だけでは許可されません。
3. Actions → **Issue to Draft PR** → **Run workflow** を開き、ブランチは`main`、`issue_number`には開いているIssueの正の整数番号を指定します。
4. `prepare`、`implement`、`publish`のログを確認します。実行者と再実行者の両方にリポジトリのwrite / maintain / admin権限が必要です。Issue作成・ラベル・コメントでは起動しません。
5. Draft PRの差分、変更ファイル一覧、検証結果、未検証事項をレビューします。テスト成功はIssueの要件全体の充足を保証しません。

`AGENTS.md`に明記した自動化専用の例外として、`feat/automated-<Issue node IDのSHA-256先頭16文字>`という専用ブランチを使用します。Issue番号をブランチに含めず、PR本文の`Closes #番号`で関連付けます。mainには直接コミットしません。

同一Issueはconcurrencyで直列化します。対応ブランチにPRがある場合は、閉じたPRも含めて再作成しません。既存PRは人間が更新してください。変更がなければPRを作成しません。ブランチ作成後にPR APIだけが失敗した場合、同じmain・同じ生成内容なら再実行で既存ブランチを利用できます。異なる生成内容、手動変更、mainの更新は上書きせず停止するため、ブランチを確認して手動でPR作成・整理してください。

## 安全境界と変更範囲

- `prepare`: Issue取得と実行者権限の確認だけを行います。Issueタイトル・本文をJSONファイルとして渡し、シェルやワークフローのソースに展開しません。
- `implement`: GitHub権限はcontentsのreadのみ。checkoutの資格情報を保存せず、追跡ファイルだけを別ディレクトリへexportします。AIコンテナにはホストの`.git`、GitHubトークン、APIキー、Docker socket、Actions環境変数を渡しません。
- AIと生成コードは、capabilityを落とした非root・read-only root filesystemのコンテナで実行します。メモリ4 GiB、CPU 2、プロセス256、AI実行30分、各独立チェック3分を上限とします。ジョブ全体は60分です。
- AIコンテナはDockerのinternal networkだけに接続します。外部通信できる別コンテナの中継が、固定したDeepSeekのchat completions APIにだけ接続します。キーはこの中継の環境変数にのみ渡します。中継にはワークスペースをmountせず、任意URL・リダイレクト・別モデルを許可しません。
- APIは最大150リクエスト、1リクエスト512 KiB（524,288 bytes）、最大出力8,192 tokens、累積送信JSON 32 MiB（33,554,432 bytes）で制限します。失敗した送信も回数と送信量に含めます。料金による停止は行いません。これらは開発を進めながら実測で調整する初期値で、完了や金額の上限を保証しません。DeepSeek側でも残高・利用状況を管理してください。
- 通常のAIプロンプト・権限設定だけを安全境界にしません。ただしDockerや信頼したツールの脆弱性まで防ぐ保証はありません。AIに提供する追跡済みソースとIssueはDeepSeekへ送信され得ます。
- 通常の自動変更は`src/`、`tests/`、`docs/`配下の `.ts` / `.tsx` / `.js` / `.mjs` / `.cjs` / `.json` / `.md` / `.txt` と `README.md` のUTF-8通常ファイルです。最大100ファイル・提案JSON 500 KB。NULを含む内容、隠しファイル、symlink、path traversal、依存関係、ルート設定ファイルの変更は拒否します。
- `allow_maintenance=true` の実行では、さらに `AGENTS.md`、`.github/pull_request_template.md`、`.github/automation/` 直下の `.py` と `Dockerfile`、`.github/workflows/` 直下の `.yml` / `.yaml` を提案できます。下位ディレクトリや任意の `.github` ファイルには拡大しません。実行中の権限・隔離・API上限は変えません。ワークフローやDockerfileの変更はデータとして公開し、その変更後の権限やイメージはこの実行では使用しません。
- AIには実装・テスト・自己修正を指示します。その終了後、依存関係を初期化し、ネットワークのない別コンテナで`pnpm lint` → `pnpm typecheck` → `pnpm format:check` → `pnpm test` → `pnpm build`を実行します。`pnpm test`内部のUnit・Integration → Build → CLI E2Eの順序は維持します。独立検証失敗時はPRを作らず停止します。
- `publish`: 新しいrunnerで、main由来の信頼したスクリプトだけを実行します。生成物はデータとして再検証し、GitHub Git APIで通常ファイルのtree・commit・branchを作成します。生成コード、テスト、install scriptは実行しません。このジョブだけにcontents / pull-requestsのwrite権限を付与します。

## ログ・失敗時の確認

- Issue不存在・閉じたIssue・PR番号・入力形式・権限不足は`prepare`のエラーを確認します。
- Secret未設定、Docker build失敗、OpenCode非ゼロ終了、APIのHTTPステータス、API利用上限、タイムアウトは`implement`を確認します。401ならキー、429なら利用制限を確認します。中継はエラー本文やAuthorizationヘッダーを出力しません。
- 生のAI transcriptは公開・artifact保存しません。モデルエラーは一般化した状態で報告するため、モデル内部の詳細は未取得です。独立チェックの出力はActionsコマンド解釈を無効にして表示します。
- GitHub APIで403になった場合はPR作成設定と組織ポリシーを確認します。途中でmainが更新された場合は最新mainから再実行します。
- Issueと提案artifactは保持1日です。失敗時は提案をuploadしません。数値と固定ラベルだけの診断artifact `issue-diagnostics` は成功・失敗時とも14日保持します。APIキーを含むartifactや.envを作成しません。
- `GITHUB_TOKEN`によるPR作成は通常の`pull_request` CIを自動起動しません。このワークフローの独立チェックを確認し、必要なら人間がブランチを更新して通常CIも実行してください。CI起動用PATで権限を増やす実装にはしていません。

## バージョンと検証

Node.js 26.12.0 / pnpm 12.14.0 / OpenCode 1.19.3を固定しています。DeepSeek公式ドキュメントに従いAPIモデルIDは`deepseek-flash`を使用します。2026年10月21日時点ではDeepSeek-V4.1-Flash-1017に対応するaliasです。モデルaliasの将来的な差し替えはこのリポジトリでは固定できません。

エージェントイメージには、保守変更の自己テスト用にDebianの `python3` も導入します。独立したPython検証には固定した `python:3.12.12-slim-bookworm` を使います。

依存関係はイメージbuild時に`pnpm install --frozen-lockfile`で導入します。オフライン実行時は`PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`により、コピーした依存関係に対する自動再インストールを抑止します。検証コマンドやlockfileは変更しません。

自動化自体の境界テスト:

```sh
python3 -B -m unittest discover -s .github/automation -p 'test_*.py' -v
```

**Automation checks** がこのテストとツールイメージのbuildを検証します。実API呼び出しと実Draft PR作成はSecret・権限・課金を伴うため、ワークフローをmainにマージした後に手動実行して確認してください。

公式仕様:

- [DeepSeek APIモデルID](https://api-docs.deepseek.com/)
- [DeepSeekとOpenCode](https://api-docs.deepseek.com/quick_start/agent_integrations/opencode/)
- [OpenCode設定](https://opencode.ai/docs/config/)
- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [GitHub ActionsのPR作成許可](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
- [GITHUB_TOKENで発生させたイベント](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)

## OpenCode実行失敗の診断

ツールのグローバルインストールでは、固定した `opencode-ai` と `pnpm` だけに npm の install script 実行を許可します。Docker build 内のバージョン確認に加え、実行前に秘密情報もネットワークも持たないコンテナで OpenCode の起動を確認します。

`implement` の診断は固定した段階・エラー種別で出力します。生の OpenCode 出力、例外メッセージ、API 本文、認証ヘッダーは公開しません。未知の異常終了は `abnormal_exit` または `agent_error` になります。

| ログ                                                 | 確認する内容                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `stage=opencode_startup error=startup_error`         | インストール・バイナリ起動の失敗                              |
| `stage=opencode_run error=configuration_error`       | OpenCode 設定の読み込み失敗                                   |
| `stage=opencode_run error=model_configuration_error` | プロバイダー・モデル設定                                      |
| `stage=opencode_run error=api_error`                 | OpenCode が報告した API エラー。中継側の状態も確認            |
| `stage=opencode_run error=timeout`                   | AI 実行の30分制限                                             |
| `stage=api outcome=http_error ... http_status=401`   | DeepSeek が返した HTTP ステータス。401 は認証、429 は利用制限 |
| `stage=api outcome=timeout` / `transport_error`      | 中継から DeepSeek への接続・応答待ちの失敗                    |
| `stage=api outcome=rejected`                         | 未対応エンドポイント、不正な入力、既存の利用量上限            |
| `stage=api error=diagnostics_unavailable`            | 中継ログを取得できず、API 利用の有無も判定不能                |

`received` は中継が受信した POST 数、`attempted` は DeepSeek への送信試行数です。`attempted=0` なら外部 API 呼び出しは未試行です。送信試行は DeepSeek 側での受信を保証しません。`http_status=0` は HTTP 応答未取得、200 などの値は実際に受け取ったステータスです。`outcome=success` は HTTP 応答の受信を示し、その後の本文解釈で `invalid_response` になる場合があります。起動直後にもゼロ件の状態を出力するため、API 呼び出しがない場合と診断取得失敗を区別できます。

Issue #10 の起動引数を固定バージョンで再現すると、配列引数 `--file` が後続のプロンプトもファイル名として取り込み、`File not found` で停止しました。添付ファイル指定の後に `--` を挿入してプロンプトを区切り、モック試験でも同じ添付形式を使用します。元の実行では npm の install script 未許可警告もありましたが、この警告だけが原因だと断定するものではありません。実 API を使用した元の Issue #9 の再実行は、修正を main にマージした後に行い、API 接続・実装・独立検証・Draft PR 作成まで確認してください。モック試験の成功だけでは実 API での復旧確認にはなりません。

### 中継によるリクエスト拒否

`stage=api outcome=rejected` は DeepSeek の HTTP エラーとは別で、中継が外部送信前に停止した状態です。`stage=api_budget` に固定した拒否理由と数値だけを記録します。

| `reason`               | 意味                                              |
| ---------------------- | ------------------------------------------------- |
| `invalid_request_size` | Content-Length が不正、または受信サイズ上限を超過 |
| `request_too_large`    | DeepSeek に送る JSON が1リクエストの上限を超過    |
| `request_limit`        | 最大150リクエストを消費済み                       |
| `reserved_limit`       | 送信 JSON の累計32 MiBを超過                      |
| `invalid_payload`      | JSON、モデル、必須フィールドなどが不正            |
| `unsupported_endpoint` | 許可していないエンドポイント                      |
| `none`                 | 拒否以外の通常の状態                              |

`request_bytes` は送信しようとした JSON の UTF-8 bytes、`reserved` は送信 JSON の累積 bytes です（従来のフィールド名を維持しています）。拒否された送信は外部 API に到達せず、予約残高を変更しません。DeepSeek に送信を試みた呼び出しは、HTTP エラーでも予約を消費します。

日本語を Unicode エスケープで膨らませないよう、送信 JSON は意味を保ったまま UTF-8・空白なしで構築します。バイト数とトークン数を加算する旧方式をやめ、通信量は JSON bytes、モデル利用量は API の実トークン数として分けて記録します。上限到達だけで自動的に予算を増やしたり、無制限に再試行したりしません。

2026-10-22 の実行 `39721914337` は起動成功後、DeepSeek への10回の送信で HTTP 200 を受け取り、11回目が中継で拒否されました。当時の `rejected` ログには内訳がなく、累積予算・サイズ・入力不正のどれかまでは確定できません。また、コマンド実行権限の設定名が `shell` になっていたため、OpenCode のツール名 `bash` に修正しました。モック試験は固定のコマンド実行・読取・編集を要求し、実際のファイルの変更まで確認します。単なる返答や HTTP 200 だけを実装成功と扱いません。

### 過去の累積予約上限の引き上げ

実 API の実行で、累積469,443単位を消費した後、11回目の要求61,006 bytesと出力予約4,096単位を加えた534,545単位が旧上限500,000単位を超え、`reserved_limit` で停止することを確認しました。当時は利用者の承認に基づき累積上限を2,000,000単位へ引き上げ、1回120,000 bytes、最大24リクエスト、最大出力4,096 tokens、AI実行20分としていました。現在は次節の開発用初期制限を使用します。

予約単位は金額や実際のトークン数ではありません。上限の引き上げは API 利用量・課金が増える余地を広げます。旧実行の11回目は新上限に収まりますが、Issue の実装完了や新上限内での完了を保証するものではありません。

### 開発を進めながら調整する初期制限と記録

| 項目                       | 初期値                              |
| -------------------------- | ----------------------------------- |
| API 送信試行               | 150回（タイトル生成・要約等も含む） |
| 1要求のJSON                | 512 KiB                             |
| 累積送信JSON               | 32 MiB                              |
| 1回の最大出力              | 8,192 tokens                        |
| OpenCodeのコンテキスト設定 | 131,072 tokens                      |
| AI実行                     | 30分                                |
| 独立チェック               | 各3分                               |
| implementジョブ全体        | 60分                                |

これらは小規模な開発を試すための暫定値です。回数・通信量・時間を無制限にはせず、料金からの厳密な停止制御や固定の累計トークン上限は追加しません。モデル、Docker隔離、GitHub権限、変更可能パス、独立検証とDraft PRのみの公開方針は維持します。

Issue #20でAPI送信試行上限を100回から150回へ引き上げました。利用量・費用が増える可能性があり、完了や金額の上限は保証しません。回数・累積送信JSON 32 MiB・1要求512 KiB・実行時間などの制限は独立しており、別の制限に先に達すると150回未満でも停止します。150回目まで他の制限内で送信でき、151回目は外部送信前に `request_limit` で拒否します。HTTPエラー等の失敗した送信試行も回数と累積送信量を消費し、拒否された要求ではどちらも増やしません。新上限は変更をmainへマージした後、最新mainから新しく手動実行した場合に適用されます。旧実行の再実行には変更前のコード・上限が適用されます。

`issue-diagnostics` の `diagnostics.json` には実行時の制限、結果、処理時間、API試行数、実入力・出力トークン、入力キャッシュヒット・ミストークン、出力打ち切り回数、停止理由を記録します。各応答の `completed_at_unix` はUTCのUnix時刻、`elapsed_ms` は当該API応答までの時間です。レポート最上位の `elapsed_ms` は中継準備から独立チェックまでを含む実行時間です。本文・認証情報・例外メッセージは保存しません。料金計算は実施せず、公式単価と数値の照合に利用できます。

- `summary` のトークン合計は取得できた応答の小計です。`usage_unknown` が0より大きい場合、実行全体の利用量ではありません。
- タイムアウトや欠落・不正な usage は消費ゼロとみなさず不明として残します。キャッシュ内訳がない場合も不明とし、キャッシュなしと断定しません。
- `output_truncations` は `finish_reason=length` の回数です。モデルの進捗や成果物の正しさを保証する数値ではありません。
- `summary.stop_reason` は中継の上限理由を優先し、ほかにAI・検証タイムアウト、検証失敗などの固定理由を記録します。失敗した実行から未検証の提案を公開しません。
- 初期設定不備やrunnerの強制停止などでは診断を作成できない場合があります。中継ログが取得不能な場合は `diagnostics_available=false` として記録します。
- 記録は1回のワークフロー実行単位です。同一Issueの再実行は別記録・別上限となるため、1 PRに至る費用を見る場合は失敗した試行も集計します。GitHubの実行番号・attemptとartifactを対応づけて比較してください。

数件から十数件の実行後、完了率、停止理由、入力・出力・キャッシュ量、出力打ち切り、所要時間を比較して調整します。上限に余裕があるのに進まない場合は、プロンプトやツールの失敗を別途調べます。設定は自動的には変更しません。

## Repository Policy Checkと保守変更

実装前に、AIへIssueの目的・スコープ・受け入れ条件と、`AGENTS.md`、Issue設計ガイド、この文書、PRテンプレートの参照を指示します。許可範囲で実現できない場合は、部分実装や禁止操作の繰り返しをせず停止するよう指示します。プロンプトだけでは遵守を保証しません。

実装後は、mainの固定したbaseから読み込んだ信頼した `policy.py` で、要求形式、ブランチ名、変更可能パス、拡張子、通常のUTF-8テキスト、重複ファイルを検査します。公開直前にも新しいrunner上の同じbaseのコードで検査し、現在のIssue node IDから生成ブランチを照合します。Issueのタイトル・本文が実行中に変わった場合も公開を停止します。PR本文のIssue紐づけと、変更概要・関連Issue・実装内容・実行したテスト・テスト結果・未検証事項の各項目を、GitHubへの最初の書き込み前に検査します。生成された `policy.json` の自己申告を合否判定には使いません。

保守変更でも、ホストの実行コード、公開処理、ポリシー、依存関係、Dockerイメージは変更前のbaseに固定します。候補のPythonは、ネットワーク・秘密情報なし、非root、read-only、リソース制限付きの別Pythonコンテナで実行します。変更前の境界テストと候補のテストを別々のPythonプロセスで実行し、両方の成功を追加の `automation` チェックとして要求します。候補のテストやモジュールも信頼できないコードであり、成功は安全性の証明ではありません。ワークフロー実行やDockerfileの再ビルドはこの追加チェックには含めません。これらの変更後の挙動は人間が差分をレビューし、通常CI等で確認します。

ポリシー違反時は `stage=repository_policy error=<固定ラベル>` で停止し、PRを作成しません。実装側では `policy.json` に固定した違反種別を記録し、`issue-diagnostics` に保存します。API診断の停止理由は `repository_policy_failed` になります（API上限で停止した場合は上限理由を優先）。診断にIssue本文、ファイル内容、生のAIログ、例外詳細、秘密情報を含めません。

機械的なスコープ判定は許可パスの範囲だけです。Issueとの意味的整合、受け入れ条件全体の充足、設計・依存・権限変更の事前承認の妥当性、生成テスト、自動化の安全性は未検証として残し、PR本文に人間の確認事項を明記します。`allow_maintenance` は提案許可であり、変更後のGitHub権限やポリシーの適用承認ではありません。Draft PRのみを作成し、自動承認・自動マージは行いません。GitHub側のトークンや組織ポリシーがワークフローファイルの公開を拒否する場合は、安全に停止します。PATの追加や権限の自動拡大は行わず、人間が通常の開発フローで対応してください。

### Issue #18の失敗した実行について

実行 `39746532604` は100回のAPI送信に成功した後、101回目を `request_limit` で拒否して停止しました。生のAIログを保存していないため、ツール呼び出しの具体的な繰り返しは判定不能です。一方、当時はIssue #18が要求する `AGENTS.md` と自動化コードの変更が禁止されており、その許可範囲では完了できませんでした。PR #19ではAPI上限は増やさず、保守変更の明示的な提案許可と独立検証を追加しました。旧実行の再実行は古いコードを使うため、修正をmainにマージ後、最新mainから新しく手動実行してください。#18自体をこの修正で完了した場合は、同じIssueを再度自動実装する必要はありません。
