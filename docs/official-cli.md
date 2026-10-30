# 公式CLI接続

状態: Codex CLIへの接続置換・固定応答回帰を実装。実Plusで同じbase・Issueのcorrect/buggy全工程を評価し、correctの生成53件成功とbuggyの割引不具合検出を確認。[検証範囲と残る課題](order-api-evaluation.md#完了した実correctbuggy比較と検証範囲)を参照。一般的な生成品質の保証ではない。2026-10-28（JST）確認。

## ChatGPT Plusでの利用とセットアップ

初回は **未改変のCodex CLI 0.163.0** をローカルの子プロセスとして呼ぶ。[公式料金案内](https://developers.openai.com/codex/pricing)でCodexはChatGPT Plusに含まれるとされている。APIキー・Claude契約は不要。利用可能なモデル・回数等は契約の最新条件に従い、無制限利用や追加料金が常に不要とは保証しない。

LatchはCLIを自動導入せず、ログインも実装しない。対応版を導入する例は `npm install -g @openai/codex@0.163.0`。利用者が信頼した `codex` をPATHへ置き、公式の `codex login` でChatGPTアカウントへログインする。ブラウザ操作・tokenのコピー・独自認証APIは使わない。`--with-api-key`は使わない。

初回はLinux（WSL 2上のUbuntuを含む）・Plus/ProのChatGPTログイン・利用者設定や管理設定のないCLI環境に対応する。既存のCodex設定を変えたくない場合は、ワークツリー外の専用ディレクトリへ公式CLIでログインできる:

```sh
mkdir -p "$HOME/.local/share/latch/codex"
export CODEX_HOME="$HOME/.local/share/latch/codex"
codex login
# CODEX_HOMEを保った同じ環境からlatch plan/runを実行する。
```

これは公式CLI自身のログインであり、既存の認証ファイルをコピー・移動・削除する操作ではない。CODEX_HOME未指定なら通常の `HOME/.codex` を使う。Latchは公式CLIが返す公開アカウント状態だけを確認し、認証ファイルを探索・読取・コピーしない。

## 一次情報と選定

採用理由と代替案は [ADR 0004](adr/0004-official-model-cli.md) に記録します。以下は対応条件の根拠となる一次情報です。

[認証](https://developers.openai.com/codex/auth)、[料金](https://developers.openai.com/codex/pricing)、[非対話実行](https://developers.openai.com/codex/noninteractive)、[CLI参照](https://developers.openai.com/codex/cli/reference)、[設定参照](https://developers.openai.com/codex/config-reference)、[公開app-serverプロトコル](https://developers.openai.com/codex/app-server)を参照する。

2026-10-27、[現行モデル案内](https://learn.chatgpt.com/docs/models)と[Plusの提供内容](https://learn.chatgpt.com/docs/pricing)を再確認した。gpt-5.4/gpt-5.4-miniはChatGPTログインのCodexでは2026-08-31に提供終了している。APIキー認証側の提供とは区別する。Plusの現行案内にあるgpt-6.1-solへprofileの例を更新した。公式CLIの版と、サーバー側モデルの提供期間は別に確認する。アカウント/クライアントの展開状況により異なり得るため、例のモデルがすべてのアカウントで利用できるとは保証せず、自動切替もしない。

権限制御は、導入版と同じ [rust-v0.163.0](https://github.com/openai/codex/tree/rust-v0.163.0)（commit `83086188ae0614bd882818ff1aa23f3194962012`）の公式ソースで確認した。別版のmainから採用版の挙動を推定しない。

- [非対話CLI引数](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/exec/src/cli.rs): stdin、`--ignore-user-config`、`--ignore-rules`、`--ephemeral`、`--output-schema`、`--json`。
- [権限profileのコンパイル](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/config/permissions.rs): 明示したfilesystemルールから制限付きpolicyを作り、`network.enabled=false`はRestrictedとなる。
- [ツール登録](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/spec_plan.rs): シェル無効化とApplyPatchの登録は別。シェル停止だけで編集・読取を防げるとは仮定しない。
- [ApplyPatchの実行](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/handlers/apply_patch.rs): patchの検証・ファイルアクセスにもsandbox contextを渡す。そのため残る編集ツールにはfilesystemのdenyを適用する。
- [スキル読込](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/session/session.rs): `skip_host_skill_discovery`によるホスト側スキル探索の停止。開発中の設定なので版を固定し、別版を自動で受け付けない。
- [公開account/read](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server-protocol/schema/json/v2/GetAccountResponse.json): アカウント種別・planTypeを返し、tokenやキーを返さない。`refreshToken:false`で状態を読む。Latchはログイン・ログアウト・token更新の要求を送らない。
- [login status](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/cli/src/login.rs)はAPIキー認証時にキーの識別用表示を出すため、Latchの判定には使わない。[forced_login_method](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/manager.rs)は不一致時にlogoutする経路があるため、既存資格情報を削除しない本接続では設定しない。公開account/readでAPI認証を拒否してから推論する。

## 対応条件と起動前の拒否

版は0.163.0に固定する。HOMEとCODEX_HOMEは絶対パスで、対象ワークツリー外に置く。CLIの起動前に、次の既知の設定ファイルのメタデータを確認する。内容は読まない。

- `/etc/codex/config.toml`、`/etc/codex/requirements.toml`、`/etc/codex/managed_config.toml`
- 選択したCODEX_HOMEの `config.toml`、`requirements.toml`

いずれかが存在するか、有無を確認できない場合は停止する。設定・MCP・フック等が混入しない最小の利用条件であり、管理者のpolicyを無視・上書きする方式ではない。既存設定を自動削除せず、専用CODEX_HOMEでの公式ログインを案内する。システム管理設定のある環境、Team/Enterprise、gateway、APIキー、未知の版・planType、macOS/Windowsネイティブ・WSL 1は初回対象外である。

Codexの公開app-serverを起動し、initialize→account/readだけを要求する。ChatGPTのPlus/Pro以外ならexecを起動せず停止する。アカウント状態の確認に認証通信が生じる場合も、公式CLIへ委譲する。Latchが非公開認証APIを呼ぶことはない。

信頼したホスト・CLI・PATHと、実行中に利用者が資格情報や設定を差し替えないことを前提とする。ホスト管理者の改ざん・実行中の設定変更を防ぐOSサンドボックスではない。

## WSL 2上のUbuntu

2026-10-27、WSLを一律に拒否していた条件を修正した。次の一次資料から、通常のLinuxと同じ制限を維持してWSL 2を利用対象にする。WSL 1は除外する。

- [OpenAIのWSL手順](https://learn.chatgpt.com/docs/windows/wsl): WSL 2ではLinux側でCodexを実行する。0.115以降のLinux sandboxはbubblewrapを使い、WSL 1は非対応。現在の案内と採用版のソースを分けて確認した。
- [採用版のWSL判定](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/sandboxing/src/bwrap.rs)と[判定テスト](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/sandboxing/src/bwrap_tests.rs): WSL 1では必要なuser namespaceを作れない。WSL2と、旧形式のmicrosoft-standardカーネルをWSL 1から区別する。
- [採用版のLinux sandbox](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/linux-sandbox/src/bwrap.rs)と[seccomp](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/linux-sandbox/src/seccomp.rs): 制限された実行でWSLのWindowsプロセス起動用ブリッジ（/run/WSLとVM socket）を扱う。Latchはこの公式実装を変更せず、ツールの無効化とfilesystem/networkの拒否を維持する。
- [MicrosoftのWSL比較](https://learn.microsoft.com/en-us/windows/wsl/compare-versions): WSL 2は実際のLinuxカーネルを利用する。[ファイル配置の推奨](https://learn.microsoft.com/en-us/windows/wsl/filesystems)に従い、Linuxツールで扱うリポジトリはLinux側へ置く。

LatchはNode.jsのprocess.platformとos.release()を使い、通常のLinux、WSL2の識別子、旧microsoft-standard形式を受け付ける。WSL 1または判別できないWSL形式は推論前に拒否する。WSL_DISTRO_NAME等の環境変数だけでは受け付けない。これは対応環境の選別で、カーネルの安全性を証明する検査ではない。

Node.js・pnpm・Git・CodexはUbuntu側に導入し、リポジトリ・HOME・CODEX_HOMEはLinux側（例: /home/user/code）に置く。Windows版Node/Codexや/mnt/c上での運用は今回の検証対象に含めない。配置の自動移動や設定変更はしない。操作とWSL上での確認手順は [初めてのコードレビュー](review-walkthrough.md) を参照する。

この開発環境は通常のLinuxであり、WSLカーネル文字列の固定応答テストとは別に、2026-10-27の利用者提供ログで実WSL 2上の自動テスト206件・ビルドと、実Codexの未ログイン起動検査1件の成功を確認した（[記録](evaluations/wsl2-startup-2026-10-27.json)）。助手が利用者端末で直接実行したものではなく、全WSL環境を保証しない。実Plusのcorrect/buggy比較は最新評価記録の範囲で確認済み。WSLでも管理設定・版・送信許可・権限の条件は同じであり、起動失敗時に権限を緩めて再実行しない。

## 権限制限とLatchの責務

モデル用CLIは対象リポジトリ外の空の一時cwdで起動し、許可済みの明示入力だけをstdinへ渡す。要件抽出にはIssue・除外後の差分・テスト候補、生成には計画済み条件と差分・候補、修復には生成コードと切り詰めた実行エラーを使う。リポジトリ全体やCLIの認証情報を入力にしない。呼出し契約が差分に含まれない場合は、source区分とallowed.sourceFilesで個別に許可したJS/TSファイルの全文を計画・生成・修復へ追加できる。許可とSHA-256を実行前に照合し、変更時は再計画を求める。設定とWSLでの再評価手順は [ソース入力](source-inputs.md) を参照する。

[設定の実装](../src/plan/codex-policy.ts)で次を固定する。

- `permissions.latch.filesystem={":root"="deny"}` と `permissions.latch.network.enabled=false`。モデル用ツールの読取・書込・通信を拒否し、`approval_policy="never"`で権限拡大を許さない。CLI自身が行う認証やschema読込とは別の境界である。
- シェル、画像読取、Code Mode、外部アプリ・プラグイン・フック、エージェント委譲等を無効化する。Web検索もdisabled。ApplyPatch等がモデルに見えても、ファイル権限は与えない。ツール操作を示すイベントを受けた場合は結果を採用しない。
- `project_doc_max_bytes=0`とホストスキル探索停止で、AGENTS.mdやスキル等を明示入力以外から収集しない。
- `exec --ignore-user-config --ignore-rules --strict-config --ephemeral --skip-git-repo-check --json --output-schema ...`を使う。公開状態確認のapp-serverにはignore-user-configがないため、前段でCLI設定の存在も拒否する。
- 環境はHOME・CODEX_HOME・PATH・言語・一時領域・標準proxy/CA設定だけに限定する。OPENAI_API_KEY、CODEX_API_KEY、CODEX_ACCESS_TOKEN、NODE_OPTIONS等を継承しない。対象テストには別の空HOMEを渡し、CODEX_HOMEも渡さない。

[製品方針](product-vision.md#自前実装を最小化する原則)に従い、認証・通信・資格情報の保存と更新・モデル実行・構造化出力は公式CLIへ委譲する。Latchは送信許可、入力の固定、生成結果と出典の検証、隔離実行、要件・証拠レポートを持つ。キーの識別表示を読まずにアカウント状態を確認するため、tokenを返さない短い固定の公開RPCを使う。汎用RPCクライアントや独自認証は持たない。任意に指定された期限・出力上限・キャンセルとプロセスグループ終了はLatchの実行契約なので標準のNode.js spawnで扱う。

既知の認証パス（`.codex/`・`.claude/`・`.env*`・鍵等）と正解データを入力・候補探索・隔離コピーから除外し、認証パスをIssue入力にも使わせない。これは任意のソース中の秘密を検知する機能ではない。送信入力へ秘密を含めない。

## 上限・失敗・移行

profileは [version 2](requirement-planning.md#許可profile)、providerは `codex-cli`。version 1、endpoint/apiKeyEnv/maxOutputTokens等の旧API設定は移行案内付きで拒否し、HTTP・キー解決を削除済み。API方式やClaudeへのフォールバックはない。

時間・要求回数・入出力サイズは既定でLatch側の上限なしとし、profileの項目省略またはnullで表す。指定する場合は正の安全な整数をそのまま使い、最大120秒・3回等へ丸めない。maxRequestsはplan/runごとの推論用CLI起動数で、版・アカウント状態確認は数えない。CLI内部のHTTP再試行・model turn数・token数・費用の上限とは異なる。runの自動修復は条件ごとに既定1回で、maxRepairAttemptsで任意の非負整数へ変更できる。Latchによる無限の自動再試行は追加しない。

期限を指定した場合は版・状態確認も含めて適用する。期限なしでもSIGINT/SIGTERMによるキャンセル時はプロセスグループを終了し、一時領域を削除する。時間・出力上限を指定した場合の超過も同様に終了する。必須上限を外しても送信許可・モデル用ツールの権限・資格情報保護は変えない。詳細は [上限の設定](requirement-planning.md#呼び出し量時間再試行の上限) を参照する。

未導入・対応条件不一致・未ログイン・認証失敗・利用上限・指定モデルの非対応/提供終了・不正JSON/構造化出力・タイムアウト・キャンセルを区別して終了コード2で停止する。既知のモデルエラーは固定文言で利用者管理profileの変更を案内し、自動再試行やモデル切替はしない。未知のエラーは汎用の実行失敗とし、raw stdout/stderr・アカウント情報を出力しない。

## 検証と実利用評価

固定応答テストは偽のcodexをPATHへ置き、公開account/readとexecの同じプロセス境界を通す。管理設定のないホスト条件はテスト内のfixtureで再現し、製品に拒否を回避する環境変数等は追加しない。correct/buggy・曖昧な要件・実行不能について、計画から隔離実行・両レポートまで検証する。実モデル品質の評価ではない。

公式CLIを指定した任意の未ログイン検査:

```sh
LATCH_OFFICIAL_CLI=/absolute/path/to/codex \
  pnpm exec vitest run --project integration tests/integration/official-cli-startup.test.ts
```

新しい空HOMEを使用し、公開account/readで未ログイン、config/readでdeny profileと機能制限、thread/startで有効profile・ネットワーク制限・指示ファイル未読込を確認する。turn/startは送らない。対応外のシステム設定があるホストではskipする。通常CIは実CLIを要求せず、この任意検査をskipする。導入済み0.163.0では、空HOMEからの公開RPCによるprofileコンパイルと、最終機能設定のfeatures listによる解析（終了0）を別途確認した。これは実Plusアカウントの検証ではない。

### 旧評価と修正の経緯

以下は当時の失敗・未達の履歴。現在の到達点は [検証範囲と残る課題](order-api-evaluation.md#完了した実correctbuggy比較と検証範囲) を参照する。

Plusログインでのplan成功とrun・レポート出力は利用者提供JSONで確認したが、正しい候補で7条件の誤検出があり、生成品質・正誤比較・敵対的入力・利用量の評価は未完了。実ログイン可能な対応環境を用意し、利用者の指定した利用範囲（任意上限の有無を含む）を記録してから [評価手順](order-api-evaluation.md)で実施する。旧1 USD API予算は流用しない。開発環境の自動テストによる実モデル要求は0件。利用者の実ログインでcorrect候補のplanを1回試みたが実行失敗し、この最初の試行ではplan/runは完了しなかった（その後のplan成功とrunの不具合は下記）（[失敗記録](evaluations/codex-real-attempt-2026-10-27.json)）。CLI内部のmodel turn数・利用量は不明で、0とは記録しない。廃止モデルを指定した設定上の問題を修正し、実測を続ける。#81を完了・自動closeしない。

2026-10-27、利用者提供のgpt-6.1-solによる実計画JSONで、8要件・15条件・11生成対象条件のplan成功を確認した。続くrunは複数生成テストの証拠IDが重複し、レポート検証で終了コード2となった（[記録](evaluations/codex-real-plan-run-2026-10-27.json)）。IDへ実行単位と修復試行を含める修正を行い、複数条件の成功・失敗と参照先を固定応答で回帰する。修正後の実機runでID重複は解消したが、以下の誤検出が残るため品質評価の完了とはしない。

修正後の利用者提供レポートはverification=completed、全16証拠IDが一意、既存5件成功、生成11件中4件成功・7件失敗だった（[記録](evaluations/codex-real-correct-run-2026-10-27.json)）。正しい候補に対し、6件はHTTP模擬リクエストのon(data/end)と実装の非同期イテレーターの不一致、1件はserver.tsのimportだけでサーバーが生成されるという誤った前提だった。公開サンプルを用いたローカル確認では、非同期イテレーター形式にすると意図した6種類のレスポンスになり、createAppを呼ぶとrequest listenerが登録されることを確認した。これは全生成アサーションの再実行ではない。生成入力が差分・条件・候補名に限られ実際の呼出し契約を十分に渡せていないことが改善点で、対象コードの不具合検出達成に数えない。追加のモデル要求は行わず、生成品質は未合格として#81を継続する。

呼出し契約の不足への対応として、明示許可したソース全文を追加する機能を実装した。固定応答の回帰では非同期イテレーターとcreateAppを使ったHTTPテストを実際に隔離実行し、correctの成功とbuggyの割引不具合による失敗を区別する。これは実モデルが同じテストを生成する保証ではなく、correctとbuggyを実Plusで比較するまで品質改善の完了とはしない。

2026-10-28（JST）に確認した利用者提供のソース入力追加後のcorrectレポートは、既存5件・生成53件成功、条件14件検証成功・3件要件不明確だった。HTTPの非同期イテレーターとcreateApp呼出しを生成コードで確認したが、条件構成が変わっており旧7条件との同条件比較ではない。buggyは応答契約の検査で終了2、レポートは空で、初回生成/修復のどちらか・具体的違反箇所・実テスト結果は旧ログから判断できない。[評価記録](evaluations/codex-real-source-inputs-2026-10-28.json)を保持し、エラーへ段階・項目・固定理由を追加した。生の応答を公開・保存せず、#81の比較評価は継続する。

続く利用者ログで、06da8e9の初回生成tests[0].codeが単純なtest/it文字列検査で拒否されたと確認した。応答コードは未取得で、その構文自体は断定できない。一方、この検査は有効なtest.each/test.for/別名importも拒否するため撤去し、importとテスト登録の妥当性は隔離コピーのVitestに委譲した。テスト未登録を検証成功へ変えず、条件ID・JSON・コード文字列の契約検証は維持する。

### 最新の実比較

利用者提供の最終buggyレポートでverification=completed、既存5件成功、生成33件成功・2件失敗、条件12件検証成功・1件失敗・1件未検証・3件要件不明確を確認した。test.eachによる2失敗はMath.floor→Math.roundの既知不具合に一致し、40証拠IDは一意、修復なし、一時領域削除成功。correctとのbase・merge-base・Issue digest一致を照合した。実行revision・全工程時間・tokens等の取得限界、試行履歴は [実利用記録](evaluations/codex-real-source-inputs-2026-10-28.json) に残す。#81の対象である公式CLIへの移行と限定した実比較の証拠を整理したが、一般的品質や安全性の完全保証、PRのマージ・Issueクローズを実施した意味ではない。
