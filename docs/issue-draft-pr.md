# IssueからDraft PRを作成する

GitHub Actionsの **Issue to Draft PR** を手動実行すると、指定したIssueをOpenCodeとDeepSeekで実装し、独立した検証に成功した変更からDraft PRを作成します。自動レビュー・自動マージは行いません。Latch CLI本体とは独立した開発用の自動化です。

## 初期設定

1. このワークフローをレビューしてmainにマージします。main以外からの手動実行は拒否します。
2. Repository Secret `DEEPSEEK_API_KEY` を設定します。既存のキーを使用でき、PATの追加は不要です。キーをIssue・ソース・Actions変数に書かないでください。
3. Settings → Actions → General → Workflow permissionsで **Allow GitHub Actions to create and approve pull requests** を有効にします。この実装はPR作成だけを使用し、承認操作は行いません。組織ポリシーで禁止されている場合は管理者による設定が必要です。
4. GitHub-hosted Ubuntu runnerからDocker Hub、npm registry、GitHub、DeepSeek APIへの通信が必要です。self-hosted runnerは想定していません。

## 実行

1. 対象Issueの目的・スコープ・受け入れ条件をレビューします。第三者のIssueも入力できるため、本文の内容を確認してから実行してください。
2. Actions → **Issue to Draft PR** → **Run workflow** を開き、ブランチは`main`、`issue_number`には開いているIssueの正の整数番号を指定します。
3. `prepare`、`implement`、`publish`のログを確認します。実行者と再実行者の両方にリポジトリのwrite / maintain / admin権限が必要です。Issue作成・ラベル・コメントでは起動しません。
4. Draft PRの差分、変更ファイル一覧、検証結果、未検証事項をレビューします。テスト成功はIssueの要件全体の充足を保証しません。

`AGENTS.md`に従い、`feat/automated-<Issue node IDのSHA-256先頭16文字>`という専用ブランチを使用します。Issue番号をブランチに含めず、PR本文の`Closes #番号`で関連付けます。mainには直接コミットしません。

同一Issueはconcurrencyで直列化します。対応ブランチにPRがある場合は、閉じたPRも含めて再作成しません。既存PRは人間が更新してください。変更がなければPRを作成しません。ブランチ作成後にPR APIだけが失敗した場合、同じmain・同じ生成内容なら再実行で既存ブランチを利用できます。異なる生成内容、手動変更、mainの更新は上書きせず停止するため、ブランチを確認して手動でPR作成・整理してください。

## 安全境界と変更範囲

- `prepare`: Issue取得と実行者権限の確認だけを行います。Issueタイトル・本文をJSONファイルとして渡し、シェルやワークフローのソースに展開しません。
- `implement`: GitHub権限はcontentsのreadのみ。checkoutの資格情報を保存せず、追跡ファイルだけを別ディレクトリへexportします。AIコンテナにはホストの`.git`、GitHubトークン、APIキー、Docker socket、Actions環境変数を渡しません。
- AIと生成コードは、capabilityを落とした非root・read-only root filesystemのコンテナで実行します。メモリ4 GiB、CPU 2、プロセス256、AI実行20分、各独立チェック3分を上限とします。ジョブ全体は35分です。
- AIコンテナはDockerのinternal networkだけに接続します。外部通信できる別コンテナの中継が、固定したDeepSeekのchat completions APIにだけ接続します。キーはこの中継の環境変数にのみ渡します。中継にはワークスペースをmountせず、任意URL・リダイレクト・別モデルを許可しません。
- APIは最大24リクエスト、1リクエスト120,000 bytes、最大出力4,096 tokens、累積500,000の予約単位（送信JSON bytesと最大出力tokensの和）で制限します。失敗した呼び出しも消費します。これはドル建て課金の厳密な上限ではありません。DeepSeek側でも残高・利用状況を管理してください。
- 通常のAIプロンプト・権限設定だけを安全境界にしません。ただしDockerや信頼したツールの脆弱性まで防ぐ保証はありません。AIに提供する追跡済みソースとIssueはDeepSeekへ送信され得ます。
- 自動変更は`src/`、`tests/`、`docs/`、`README.md`のUTF-8通常ファイルだけです。最大100ファイル・提案JSON 500 KB。隠しファイル、symlink、path traversal、ワークフロー、`AGENTS.md`、依存関係、設定ファイルの変更は拒否します。これらが必要なIssueは人間が通常の開発フローで対応してください。
- AIには実装・テスト・自己修正を指示します。その終了後、依存関係を初期化し、ネットワークのない別コンテナで`pnpm lint` → `pnpm typecheck` → `pnpm format:check` → `pnpm test` → `pnpm build`を実行します。`pnpm test`内部のUnit・Integration → Build → CLI E2Eの順序は維持します。独立検証失敗時はPRを作らず停止します。
- `publish`: 新しいrunnerで、main由来の信頼したスクリプトだけを実行します。生成物はデータとして再検証し、GitHub Git APIで通常ファイルのtree・commit・branchを作成します。生成コード、テスト、install scriptは実行しません。このジョブだけにcontents / pull-requestsのwrite権限を付与します。

## ログ・失敗時の確認

- Issue不存在・閉じたIssue・PR番号・入力形式・権限不足は`prepare`のエラーを確認します。
- Secret未設定、Docker build失敗、OpenCode非ゼロ終了、APIのHTTPステータス、API利用上限、タイムアウトは`implement`を確認します。401ならキー、429なら利用制限を確認します。中継はエラー本文やAuthorizationヘッダーを出力しません。
- 生のAI transcriptは公開・artifact保存しません。モデルエラーは一般化した状態で報告するため、モデル内部の詳細は未取得です。独立チェックの出力はActionsコマンド解釈を無効にして表示します。
- GitHub APIで403になった場合はPR作成設定と組織ポリシーを確認します。途中でmainが更新された場合は最新mainから再実行します。
- Issueと提案artifactは保持1日です。失敗時は提案をuploadしません。APIキーを含むartifactや.envを作成しません。
- `GITHUB_TOKEN`によるPR作成は通常の`pull_request` CIを自動起動しません。このワークフローの独立チェックを確認し、必要なら人間がブランチを更新して通常CIも実行してください。CI起動用PATで権限を増やす実装にはしていません。

## バージョンと検証

Node.js 26.12.0 / pnpm 12.14.0 / OpenCode 1.19.3を固定しています。DeepSeek公式ドキュメントに従いAPIモデルIDは`deepseek-flash`を使用します。2026年10月21日時点ではDeepSeek-V4.1-Flash-1017に対応するaliasです。モデルaliasの将来的な差し替えはこのリポジトリでは固定できません。

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
| `stage=opencode_run error=timeout`                   | AI 実行の20分制限                                             |
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
| `request_limit`        | 最大24リクエストを消費済み                        |
| `reserved_limit`       | JSON bytes + 出力予約の累積500,000単位を超過      |
| `invalid_payload`      | JSON、モデル、必須フィールドなどが不正            |
| `unsupported_endpoint` | 許可していないエンドポイント                      |
| `none`                 | 拒否以外の通常の状態                              |

`request_bytes` は送信しようとした JSON の UTF-8 bytes、`reserved` は既に予約した累積単位です。拒否された送信は外部 API に到達せず、予約残高を変更しません。DeepSeek に送信を試みた呼び出しは、HTTP エラーでも予約を消費します。

日本語を Unicode エスケープで膨らませないよう、送信 JSON は意味を保ったまま UTF-8・空白なしで構築します。利用量上限の値や予約計算式は変更しません。上限到達だけで自動的に予算を増やしたり、無制限に再試行したりしません。

2026-10-22 の実行 `39721914337` は起動成功後、DeepSeek への10回の送信で HTTP 200 を受け取り、11回目が中継で拒否されました。当時の `rejected` ログには内訳がなく、累積予算・サイズ・入力不正のどれかまでは確定できません。また、コマンド実行権限の設定名が `shell` になっていたため、OpenCode のツール名 `bash` に修正しました。モック試験は固定のコマンド実行・読取・編集を要求し、実際のファイルの変更まで確認します。単なる返答や HTTP 200 だけを実装成功と扱いません。
