# 公式CLI接続（#81）

状態: Codex CLIへの接続置換・固定応答回帰を実装。実際のPlusアカウントでの全工程・生成品質の評価は未実施。[Issue #81](https://github.com/shion-kamimura/latch/issues/81) は実利用評価が終わるまで完了しない。2026-10-26確認。

## ChatGPT Plusでの利用とセットアップ

初回は **未改変のCodex CLI 0.163.0** をローカルの子プロセスとして呼ぶ。[公式料金案内](https://developers.openai.com/codex/pricing)でCodexはChatGPT Plusに含まれるとされている。APIキー・Claude契約は不要。利用可能なモデル・回数等は契約の最新条件に従い、無制限利用や追加料金が常に不要とは保証しない。

LatchはCLIを自動導入せず、ログインも実装しない。対応版を導入する例は `npm install -g @openai/codex@0.163.0`。利用者が信頼した `codex` をPATHへ置き、公式の `codex login` でChatGPTアカウントへログインする。ブラウザ操作・tokenのコピー・独自認証APIは使わない。`--with-api-key`は使わない。

初回はLinux（WSL以外）・Plus/ProのChatGPTログイン・利用者設定や管理設定のないCLI環境に対応する。既存のCodex設定を変えたくない場合は、ワークツリー外の専用ディレクトリへ公式CLIでログインできる:

```sh
export CODEX_HOME="$HOME/.local/share/latch/codex"
codex login
# CODEX_HOMEを保った同じ環境からlatch plan/runを実行する。
```

これは公式CLI自身のログインであり、既存の認証ファイルをコピー・移動・削除する操作ではない。CODEX_HOME未指定なら通常の `HOME/.codex` を使う。Latchは公式CLIが返す公開アカウント状態だけを確認し、認証ファイルを探索・読取・コピーしない。

## 一次情報と選定

[認証](https://developers.openai.com/codex/auth)、[料金](https://developers.openai.com/codex/pricing)、[非対話実行](https://developers.openai.com/codex/noninteractive)、[CLI参照](https://developers.openai.com/codex/cli/reference)、[設定参照](https://developers.openai.com/codex/config-reference)、[公開app-serverプロトコル](https://developers.openai.com/codex/app-server)を参照する。

権限制御は、導入版と同じ [rust-v0.163.0](https://github.com/openai/codex/tree/rust-v0.163.0)（commit `83086188ae0614bd882818ff1aa23f3194962012`）の公式ソースで確認した。別版のmainから採用版の挙動を推定しない。

- [非対話CLI引数](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/exec/src/cli.rs): stdin、`--ignore-user-config`、`--ignore-rules`、`--ephemeral`、`--output-schema`、`--json`。
- [権限profileのコンパイル](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/config/permissions.rs): 明示したfilesystemルールから制限付きpolicyを作り、`network.enabled=false`はRestrictedとなる。
- [ツール登録](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/spec_plan.rs): シェル無効化とApplyPatchの登録は別。シェル停止だけで編集・読取を防げるとは仮定しない。
- [ApplyPatchの実行](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/handlers/apply_patch.rs): patchの検証・ファイルアクセスにもsandbox contextを渡す。そのため残る編集ツールにはfilesystemのdenyを適用する。
- [スキル読込](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/session/session.rs): `skip_host_skill_discovery`によるホスト側スキル探索の停止。開発中の設定なので版を固定し、別版を自動で受け付けない。
- [公開account/read](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server-protocol/schema/json/v2/GetAccountResponse.json): アカウント種別・planTypeを返し、tokenやキーを返さない。`refreshToken:false`で状態を読む。Latchはログイン・ログアウト・token更新の要求を送らない。
- [login status](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/cli/src/login.rs)はAPIキー認証時にキーの識別用表示を出すため、Latchの判定には使わない。[forced_login_method](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/manager.rs)は不一致時にlogoutする経路があるため、既存資格情報を削除しない本接続では設定しない。公開account/readでAPI認証を拒否してから推論する。

利用者がChatGPT Plusだけを持つため、先に試作したClaude Code接続をCodexへ置換した。両方の実装・自動切替は保持しない。CLIの一般的な機能数ではなく、利用者の契約と必要な権限制御に合わせた選定である。

## 対応条件と起動前の拒否

版は0.163.0に固定する。HOMEとCODEX_HOMEは絶対パスで、対象ワークツリー外に置く。CLIの起動前に、次の既知の設定ファイルのメタデータを確認する。内容は読まない。

- `/etc/codex/config.toml`、`/etc/codex/requirements.toml`、`/etc/codex/managed_config.toml`
- 選択したCODEX_HOMEの `config.toml`、`requirements.toml`

いずれかが存在するか、有無を確認できない場合は停止する。設定・MCP・フック等が混入しない最小の利用条件であり、管理者のpolicyを無視・上書きする方式ではない。既存設定を自動削除せず、専用CODEX_HOMEでの公式ログインを案内する。システム管理設定のある環境、Team/Enterprise、gateway、APIキー、未知の版・planType、macOS/Windows/WSLは初回対象外である。

Codexの公開app-serverを起動し、initialize→account/readだけを要求する。ChatGPTのPlus/Pro以外ならexecを起動せず停止する。アカウント状態の確認に認証通信が生じる場合も、公式CLIへ委譲する。Latchが非公開認証APIを呼ぶことはない。

信頼したホスト・CLI・PATHと、実行中に利用者が資格情報や設定を差し替えないことを前提とする。ホスト管理者の改ざん・実行中の設定変更を防ぐOSサンドボックスではない。

## 権限制限とLatchの責務

モデル用CLIは対象リポジトリ外の空の一時cwdで起動し、許可済みの明示入力だけをstdinへ渡す。要件抽出にはIssue・除外後の差分・テスト候補、生成には計画済み条件と差分・候補、修復には生成コードと切り詰めた実行エラーを使う。リポジトリ全体やCLIの認証情報を入力にしない。

[設定の実装](../src/plan/codex-policy.ts)で次を固定する。

- `permissions.latch.filesystem={":root"="deny"}` と `permissions.latch.network.enabled=false`。モデル用ツールの読取・書込・通信を拒否し、`approval_policy="never"`で権限拡大を許さない。CLI自身が行う認証やschema読込とは別の境界である。
- シェル、画像読取、Code Mode、外部アプリ・プラグイン・フック、エージェント委譲等を無効化する。Web検索もdisabled。ApplyPatch等がモデルに見えても、ファイル権限は与えない。ツール操作を示すイベントを受けた場合は結果を採用しない。
- `project_doc_max_bytes=0`とホストスキル探索停止で、AGENTS.mdやスキル等を明示入力以外から収集しない。
- `exec --ignore-user-config --ignore-rules --strict-config --ephemeral --skip-git-repo-check --json --output-schema ...`を使う。公開状態確認のapp-serverにはignore-user-configがないため、前段でCLI設定の存在も拒否する。
- 環境はHOME・CODEX_HOME・PATH・言語・一時領域・標準proxy/CA設定だけに限定する。OPENAI_API_KEY、CODEX_API_KEY、CODEX_ACCESS_TOKEN、NODE_OPTIONS等を継承しない。対象テストには別の空HOMEを渡し、CODEX_HOMEも渡さない。

[製品方針](product-vision.md#自前実装を最小化する原則)に従い、認証・通信・資格情報の保存と更新・モデル実行・構造化出力は公式CLIへ委譲する。Latchは送信許可、入力の固定、生成結果と出典の検証、隔離実行、要件・証拠レポートを持つ。キーの識別表示を読まずにアカウント状態を確認するため、tokenを返さない短い固定の公開RPCを使う。汎用RPCクライアントや独自認証は持たない。期限・出力上限・キャンセルとプロセスグループ終了はLatchの実行契約なので標準のNode.js spawnで扱う。

既知の認証パス（`.codex/`・`.claude/`・`.env*`・鍵等）と正解データを入力・候補探索・隔離コピーから除外し、認証パスをIssue入力にも使わせない。これは任意のソース中の秘密を検知する機能ではない。送信入力へ秘密を含めない。

## 上限・失敗・移行

profileは [version 2](requirement-planning.md#許可profile)、providerは `codex-cli`。version 1、endpoint/apiKeyEnv/maxOutputTokens等の旧API設定は移行案内付きで拒否し、HTTP・キー解決を削除済み。API方式やClaudeへのフォールバックはない。

`maxRequests`はplan/runごとのCLI推論起動数（1〜3）。版・アカウント状態確認は推論要求に数えない。CLI内部のHTTP再試行・model turn数・token数・費用の上限とは異なる。Latchは自動再試行せず、runは生成と修復の合計上限を守る。各起動単位の期限（1,000〜120,000ms）は版・状態確認も含む。タイムアウト・キャンセル・出力超過でプロセスグループを終了し、一時領域を削除する。

未導入・対応条件不一致・未ログイン・認証失敗・利用上限・不正JSON/構造化出力・タイムアウト・キャンセルを区別して終了コード2で停止する。未知のエラーは汎用の実行失敗とし、raw stdout/stderr・アカウント情報を出力しない。

## 検証と未実施の実利用評価

固定応答テストは偽のcodexをPATHへ置き、公開account/readとexecの同じプロセス境界を通す。管理設定のないホスト条件はテスト内のfixtureで再現し、製品に拒否を回避する環境変数等は追加しない。correct/buggy・曖昧な要件・実行不能について、計画から隔離実行・両レポートまで検証する。実モデル品質の評価ではない。

公式CLIを指定した任意の未ログイン検査:

```sh
LATCH_OFFICIAL_CLI=/absolute/path/to/codex \
  pnpm exec vitest run --project integration tests/integration/official-cli-startup.test.ts
```

新しい空HOMEを使用し、公開account/readで未ログイン、config/readでdeny profileと機能制限、thread/startで有効profile・ネットワーク制限・指示ファイル未読込を確認する。turn/startは送らない。対応外のシステム設定があるホストではskipする。通常CIは実CLIを要求せず、この任意検査をskipする。導入済み0.163.0では、空HOMEからの公開RPCによるprofileコンパイルと、最終機能設定のfeatures listによる解析（終了0）を別途確認した。これは実Plusアカウントの検証ではない。

実際のPlusログインでのplan/run、敵対的入力への動作、生成品質・誤検出/見逃し・利用量は未評価。利用者が指定した要求数・時間・利用量の上限が決まってから [評価手順](order-api-evaluation.md)で実施する。旧1 USD API予算は流用しない。現在の実モデル要求は0件で、#81を完了・自動closeしない。
