# 初めてのコードレビュー: WSL 2のUbuntuでLatchを使う

状態: PR #82の実装に対応した操作ガイド。WSL 2上の自動テストと公式CLIの未ログイン起動検査は利用者提供ログで成功を確認。実Plusでcorrectの生成53件成功とbuggyの割引不具合検出を確認。[受け入れ条件・証拠](issue-81-acceptance.md)に検証範囲と残る品質課題を記載。2026-10-28（JST）。

Latchは「Issueで頼んだことをコードが満たすか」を、テストと実行証拠で調べるCLIです。たとえば「負の金額を拒否する」という要件に対し、その入力で例外が出るかをテストします。設計・可読性・保守性なども含めた人のコードレビューを補助します。現在の入力はローカルGit差分とIssueのMarkdownで、GitHubのPR URLを渡す機能はありません。

## 1. Ubuntu側に道具をそろえる

WindowsのPowerShellで `wsl -l -v` を実行し、UbuntuのVERSIONが2であることを確認します。以降の操作はUbuntuのターミナルで行います。VS CodeならWSL接続したウィンドウのターミナルを使います。

```sh
# Ubuntuで確認する。Node.js 26、pnpm 12.14.0が必要。
uname -r
command -v node pnpm git codex
node --version
pnpm --version
```

Node.js・pnpm・GitはUbuntu側へ導入してください。Node.js 26の準備後、pnpmは `npm install -g pnpm@12.14.0` で導入できます。Codexが未導入または別版なら、Ubuntu側のnpmで `npm install -g @openai/codex@0.163.0` を実行します。`codex --version` の期待値は `codex-cli 0.163.0` です。Windows側にだけインストールしても同じ環境にはなりません。

リポジトリは `~/code/my-app` のようにUbuntu側へ置きます。`/mnt/c/...` はWindows側のファイルをLinuxから参照する場所で、今回の確認対象から外します。MicrosoftとOpenAIもLinux側への配置を推奨しています。一次資料と採用理由は [WSL 2対応条件](official-cli.md#wsl-2上のubuntu) を参照してください。

Latch自体もUbuntu側で準備します。正式なパッケージ配布はまだないため、リポジトリからビルドします。このガイドはPR #82を取り込んだ版を前提とします。初回は `mkdir -p ~/code` と `git clone https://github.com/shion-kamimura/latch.git ~/code/latch` で配置できます。既存の作業コピーがある場合はそれを使います。

```sh
cd ~/code/latch
pnpm install --frozen-lockfile
pnpm build
LATCH_CLI="$HOME/code/latch/dist/cli.mjs"
node "$LATCH_CLI" --help
```

以降はLatch自身のリポジトリではなく、調べたいプロジェクトのルートから実行します。上のLATCH_CLI変数は同じターミナルで使います。別の場所へ配置した場合はパスを変えてください。

## 2. 公式ログインと送信許可を準備する

既存のCodex設定と分けるため、Ubuntuのホーム内に専用のCODEX_HOMEを指定して、公式のログインを行います。

```sh
mkdir -p "$HOME/.local/share/latch/codex"
export CODEX_HOME="$HOME/.local/share/latch/codex"
codex login
```

公式の案内に沿ってChatGPT Plusアカウントでログインします。別のターミナルでも同じCODEX_HOMEを指定してください。認証ファイルをコピーしたり、APIキーをLatchへ渡したりする操作はありません。ログインだけではソース送信を許可したことにならないため、次の許可profileも必要です。

利用者が管理する `~/.config/latch/my-app.json` を作り、次の例のprojectを対象プロジェクトの絶対パスへ変えます。Gitリポジトリ内に置くと拒否されます。JSON内の `~` や `$HOME` は展開されません。modelもPlusで実際に利用できるモデルに合わせてください。

2026-10-27の [公式モデル案内](https://learn.chatgpt.com/docs/models) と [Plusの提供内容](https://learn.chatgpt.com/docs/pricing) に合わせて例をgpt-6.1-solへ更新しました。以前の例にあったgpt-5.4はChatGPTログインでは提供終了しています。CLIの版が対応していても、モデルの提供が終了している場合は利用できません。

```json
{
  "version": 2,
  "id": "my-app-local",
  "decision": "allowed",
  "allowed": {
    "provider": "codex-cli",
    "project": "/home/YOUR_USER/code/my-app",
    "dataCategories": ["issue", "diff", "tests"]
  },
  "connection": { "provider": "codex-cli", "model": "gpt-6.1-sol" },
  "execution": {
    "dependencies": { "mode": "runner", "registry": null },
    "network": { "allowedDestinations": [] }
  }
}
```

この例は実行量の上限を省略しています。時間・推論起動数・入出力量・生成量・Latch独自のメモリ上限は設けず、完了を待ちます。必要なら [許可profile](requirement-planning.md#許可profile) のlimitsと [実行設定](isolated-execution.md#実行設定の例) で指定できます。nullでも上限なしを指定できます。以前のprofileに30秒等の明示値があれば、その値は残るため削除またはnullへ変更してください。

自動修復だけは条件ごとに既定1回です。execution.limits.maxRepairAttemptsへ任意の0以上の整数を設定でき、旧最大2回の制限はありません。AIの契約上の利用枠・モデルやNode.js/OSの制約は残ります。plan/runの再実行では新たに利用枠を消費し得ます。終了しない処理はCtrl+C等で止めます。

既定のrunner方式は対象の依存をインストールせず、LatchのVitestを使います。外部パッケージが必要なプロジェクトでは、そのままでは実行できない場合があります。offline/registry方式の条件は [依存準備](isolated-execution.md#依存準備) を参照してください。

## 3. レビューする差分と要件を用意する

対象の変更ブランチへ移動し、比較先を指定します。baseは比較の基準になるブランチやコミットです。以下はorigin/mainとの差分を調べる例です。必要なブランチ取得は事前に自分で行います。

```sh
cd ~/code/my-app
git status --short
git diff origin/main...HEAD
LATCH_REVIEW="$HOME/.local/share/latch/reviews/my-app"
mkdir -p "$LATCH_REVIEW"
```

対象リポジトリ内の `latch-issue.md` へIssue本文を保存します。先頭に `# 金額の入力検証` のようなMarkdownのタイトルを置き、「負の金額はRangeError」「0は許可する」のように期待する結果を具体的に書きます。Issueファイルはリポジトリ外やシンボリックリンクでは受け付けません。GitHubからの自動取得は未実装です。すでに要件を書いたMarkdownがあれば、そのパスを使えます。

Latchはコミット済み差分だけでなく、未コミットの追跡済み変更も含めます。上のgit diffはコミット間の確認用です。未追跡ファイルは既定で除外し、必要ならverify/planの両方に `--include-untracked src/new.ts` のように明示します。

変更されていない型や初期化関数もAIへ渡したい場合は、[ソース入力](source-inputs.md) に従いsource区分と対象ファイルを許可します。選んだファイルの全文を送ります。追加した場合はplanから作り直してください。

## 4. verifyで入力だけを確認する

```sh
node "$LATCH_CLI" verify --base origin/main \
  --issue-file latch-issue.md
```

比較先・対象差分・Issue入力・除外パスを確認します。**ここではモデルを呼ばず、対象コードもテストも実行しません。** 成功表示は「入力を用意できた」という意味です。入力に秘密がないことを確認してからplanへ進みます。既知の認証パスを除外する機能はありますが、通常のソースへ埋め込まれた秘密をすべて検出する機能はありません。

## 5. planで検証計画を作り、人が確認する

```sh
node "$LATCH_CLI" plan --base origin/main \
  --issue-file latch-issue.md \
  --profile "$HOME/.config/latch/my-app.json" \
  --json > "$LATCH_REVIEW/plan.json"
```

成功した場合だけplan.jsonを開きます。終了コード1/2の場合、リダイレクトで空ファイルができてもrunへ渡しません。

Latchは許可範囲・CLI版・対応ホスト・Plus/Proのログイン状態を確認し、Issue、除外後の差分、既存Vitestテスト候補をCodexへ渡します。AIが要件を分解し、既存テスト候補と不足シナリオを提案します。**planでは対象コード・設定・テストを実行しません。**

確認するのは「要件が抜けていないか」「出典がIssueの行や差分を指しているか」「期待値が正しいか」「要件不明確を推測で埋めていないか」です。候補テストは未実行で、計画は合格の証拠ではありません。直す場合はIssueやコードを直し、planを作り直します。計画JSONの状態を書き換えて検証済みにしないでください。

planには差分やIssueの情報が含まれるため、共有先にも注意してください。`--json`なしで再実行しても同じ計画を表示するだけにはならず、再度モデルを呼び得ます。

## 6. runで不足テストを生成し、一時コピーで実行する

```sh
node "$LATCH_CLI" run --plan "$LATCH_REVIEW/plan.json" \
  --profile "$HOME/.config/latch/my-app.json" \
  > "$LATCH_REVIEW/report.txt"
```

Latchは入力を読み直し、plan時の内容と一致することを確認します。変わっていたら実行せず、再計画を求めます。次に不足シナリオのVitestテストを生成し、形式・条件ID等を検査します。

固定した入力から一時コピーを作り、生成テストをその中の `.latch/generated/` に置きます。Latchが用意したVitest設定で、計画が見つけた既存テスト候補のファイルと生成テストを実行します。対象の全テスト・lint・ビルド・通常CIをすべて実行するコマンドではありません。元のコードを自動修正・コミットせず、生成テストも元のリポジトリへ戻しません。テスト内容はレポートに残ります。

JSONが必要なら最初から `--json > "$LATCH_REVIEW/report.json"` にします。保存済みの結果を別形式へ変換するコマンドはなく、runの再実行はテスト生成・実行もやり直します。

## 7. 結果を読んで、人が修正・判断する

| 状態               | まず確認すること                                                         |
| ------------------ | ------------------------------------------------------------------------ |
| 検証成功           | そのテストの期待値が要件と合うか。未確認の条件が残っていないか           |
| 検証失敗           | 期待値と実際の値、生成テストのコード、実行ログ。テスト側の誤りも確認する |
| 未検証             | 証拠が足りない理由。生成テスト不正や既存テストのみの場合もある           |
| 要件不明確         | Issueに期待値や境界条件を追記して再計画する                              |
| 実行不能・判定不能 | 依存不足・認証・起動失敗・時間上限など。コードの不具合と決めつけない     |

たとえば「負の金額を拒否」の生成テストが失敗しても、すぐコードが悪いと断定せず、要件→テスト→ログを照合します。逆に「負の金額」の成功だけで「0」「上限値」「既存動作」まで成功したことにはなりません。

終了コード0は検証処理の完了で、失敗条件が見つかっていても0になり得ます。1は入力不正、2は実行不能・部分結果等です。要件の合否はレポートを読みます。2で部分レポートがある場合も、完了扱いにしません。コードやIssueを修正したらplanからやり直し、通常のCIと人のレビューも行います。LatchはPR投稿・承認・マージを実行しません。

## 何を制限しているか

AI用のCodexプロセスと、対象コードを動かすテストプロセスは別です。

| 場所         | 許可すること                                                        | 制限すること                                                                                                              |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 入力収集     | 指定リポジトリの差分・Issue・テスト候補の読取                       | 既知の認証パス・評価用正解データを除外。コードをimportしない                                                              |
| AI用Codex    | 明示入力からの計画・テストコード生成。公式CLIによる認証とモデル通信 | モデル用ツールのファイル読書き・ネットワークを拒否。シェル・Web検索・アプリ・フック・委譲等を無効化。権限拡大を許可しない |
| AIへの指示源 | Latchが渡す明示入力                                                 | リポジトリのAGENTS.md・ホストスキル等の自動読込を制限。Issue内の「全ファイルを送れ」等を権限にしない                      |
| テスト実行   | 一時コピーと実行に必要な依存の読取、一時領域への書込                | Node.jsの権限制限とsetupで通信・任意の子プロセス等を制限。公式CLIのHOME/CODEX_HOME・APIキー・SSH agent等を渡さない        |
| 実行量       | profileで指定した範囲                                               | 時間・回数・入出力量・生成量等の必須上限を撤去。必要ならprofileで指定。自動修復は既定1回で変更可能                        |

「AI用ツールのネットワーク拒否」は、公式CLI自身がOpenAIへモデル要求を送らないという意味ではありません。テスト通信は別に既定で遮断します。宛先単位の許可は未実装で、allowedDestinationsが空でなければ停止します。

管理設定のある環境、版の不一致、許可不足、認証失敗などでは停止します。設定の削除やサンドボックス無効化で回避する手順は提供しません。取り消す場合はprofileのdecisionをrevokedに変更します。

Node.jsのプロセス制限はコンテナやVMによる隔離ではなく、悪意あるコードの完全な封じ込めを保証しません。WSL 2自体を使っていても、Latchの各テストが専用VMへ隔離されるわけではありません。詳しい境界は [隔離実行](isolated-execution.md) を参照してください。

## WSL 2上で何を確認すればよいか

まずLatchリポジトリで `pnpm test` を実行すると、偽のCodexを使う回帰テストと、実際のNode.jsによる生成テスト実行を確認できます。ChatGPTの利用枠は消費しません。

次の任意検査は、公式Codexを新しい空HOMEで起動し、公開状態・制限設定・未ログインでの停止を確認します。実際のログインHOMEを使わず、モデルのturnは開始しません。

```sh
cd ~/code/latch
LATCH_OFFICIAL_CLI="$(command -v codex)" \
  pnpm exec vitest run --project integration tests/integration/official-cli-startup.test.ts
```

管理設定があるホスト等ではskipします。skipは合格ではありません。この検査が成功しても、実Plusアカウントによるplan/runと生成品質は別の検証です。実利用評価は [評価手順](order-api-evaluation.md) に従い、契約と利用範囲、任意上限の有無を記録して実施します。
