# 公式CLI接続（#81）

状態: 接続置換・固定応答回帰を実装。公式CLIでの実アカウント評価は未実施。[Issue #81](https://github.com/shion-kamimura/latch/issues/81) は実利用評価が終わるまで完了しない。2026-10-26、main `3ac17e0` を基準に調査・実装した。

## 採用した方式と対応条件

初回は **未改変のClaude Code 2.1.310** をローカルの子プロセスとして呼ぶ。LatchはCLIを自動インストールせず、ログインも実装しない。利用者が公式の `claude auth login` を行い、信頼した `claude` をPATHへ置く。Latchは公開された `claude auth status` の結果を使い、認証ファイルを探索・読取・コピーしない。

初回の対応範囲は、Linux（WSL以外）・絶対パスのHOME・標準の `HOME/.claude` 設定ディレクトリ・Anthropic first-party接続・ProまたはMaxのClaudeアカウントへのログインに限定する。版・認証方式・アカウント種別・接続先・設定ディレクトリが一致しない場合や、必要な状態が欠ける場合はモデル要求を送らず停止する。Team/Enterprise・macOS・Windows・WSL・gateway・環境変数のトークン/APIキーによる接続は初回対象外である。

管理者設定の制約は、未対応環境を拒否することで扱う。

- CLIの起動前に `/etc/claude-code` と `HOME/.claude/remote-settings.json` のメタデータだけを調べ、存在すれば停止する。空ディレクトリ、空・不正なキャッシュ、シンボリックリンクでも拒否する。読取権限等で有無を確認できない場合も停止する。管理者設定の内容や資格情報は読まない。
- CLIの状態確認後も同じ配置先を再確認する。`auth status`が返す `subscriptionType` は `pro` / `max` だけを受け付け、欠落・未知値は拒否する。
- 公式仕様ではサーバー管理設定はTeam/Enterprise向けである。端末側の管理設定を拒否し、さらにサーバー管理設定の対象アカウントを除くことで、ログインを維持したまま対応範囲を定める。管理設定を削除・上書きしたり、回避用の別HOMEへ資格情報を移したりしない。
- 信頼したホスト・CLI・PATHを前提とする。ホスト管理者による実行中の設定変更やCLIの改ざんを防ぐOSサンドボックスではない。対応条件を広げる際は公式仕様と起動確認を更新する。

## 一次情報・比較・採用理由

| 項目               | Codex CLI                                                                           | Claude Code                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 確認版             | 環境の0.163.0                                                                       | 採用版2.1.310                                                                                                     |
| 非対話・構造化出力 | `exec`、`--output-schema`、`--json`                                                 | `-p`、`--json-schema`、`--output-format json`                                                                     |
| 制御               | read-only sandbox、シェル・検索等の設定。シェル停止だけで全ツール停止とは判断しない | 組み込みツールを空集合へ限定し、MCPを別に拒否できる。設定・フック・コンテキストの自動読込も公式フラグで制限できる |
| 初回判断           | 今回は実装しない                                                                    | 必要な機能と対応条件が公式情報から定められるため採用                                                              |

Claude Codeの公式資料（2026-10-26確認）:

- [採用版の公開配布物](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.310): 導入版のversion/helpと状態出力の契約を確認する。

- [CLI参照](https://code.claude.com/docs/en/cli-reference): `--tools ""`で組み込みツールを無効化する。MCPは別のため `--disallowedTools mcp__*` と空の厳格MCP設定を併用する。
- [非対話・構造化出力](https://code.claude.com/docs/en/headless): JSON Schemaに対応する `structured_output` を返す。本文のJSON解析とLatchの出典・条件ID検証は別に必要。
- [認証](https://code.claude.com/docs/en/authentication): ログインと公式状態確認。採用版の状態出力は公開配布バイナリで確認し、利用する非秘密の状態フィールドが欠ければ停止する。
- [管理設定の配置先](https://code.claude.com/docs/en/managed-settings#where-each-mechanism-stores-the-policy): Linuxの端末管理設定は `/etc/claude-code` 配下。WSLにはWindowsの設定を継承する場合があるため初回は除く。
- [サーバー管理設定](https://code.claude.com/docs/en/server-managed-settings): Team/Enterpriseが対象。キャッシュは `~/.claude/remote-settings.json`。
- [disableAllHooks](https://code.claude.com/docs/en/settings-reference#disableallhooks): 利用者設定ではmanaged hooksを止められない。`--safe-mode`でも管理者フックは残るため、上記の対応条件を強制する。
- 採用版の `--help`: `--bare`はOAuth/keychainを利用しない。そのためログインを使う本方式では採用しない。`--safe-mode`は認証を維持してカスタマイズを無効化する。
- [法的条件と資格情報の利用](https://code.claude.com/docs/en/legal-and-compliance): 利用者が未改変CLIへ自分の契約でログインする場合と、第三者が利用者の資格情報で要求を中継する場合を区別する。Latchはログイン機能を提供せず、トークンの収集・中継、再販、ホスト型の共有接続を実装しない。各利用者は実行形態を適用される契約と照合する。Pro/Maxに技術的に対応することは、あらゆる月額利用を許諾するという意味ではない。

Codexの比較資料: [認証](https://developers.openai.com/codex/auth)、[非対話実行](https://developers.openai.com/codex/noninteractive)、[CLI参照](https://developers.openai.com/codex/cli/reference)、[設定参照](https://developers.openai.com/codex/config-reference)。Codexの実現不可能性を判断したものではない。今回は2つの接続層を同時に持たず、Claude Codeだけを実装する。

## 境界と責務

[製品方針](product-vision.md#自前実装を最小化する原則) に従い、公式CLIが認証・通信・資格情報の保存と更新・モデル実行・構造化出力を担う。Latchは送信許可・入力の固定・結果と出典の検証・テストの隔離実行・証拠レポートを担う。Latch固有のデータ契約は公式JSON出力だけでは代替できないため維持する。子プロセスの期限・出力上限・キャンセルとグループ終了はLatchの実行契約なので、標準のNode.js spawnで最小限の呼び出し層を持つ。認証更新・HTTP再試行・モデル出力の構造化は再実装しない。

モデル用CLIは対象リポジトリ外の空の一時ディレクトリで実行する。要件抽出には許可済みIssue・除外後の差分・テスト候補だけをstdinへ渡し、生成には計画済み条件と差分・候補、修復には対象の生成コードと切り詰めた実行エラーを渡す。プロジェクト全体をCLIに渡さない。

- `--safe-mode --restricted --setting-sources '' --settings '{"disableAllHooks":true}'`でユーザー/プロジェクト設定、フック、メモリや指示ファイル等の自動読込を制限する。管理設定はこれらのフラグで消せると仮定せず、対応条件で拒否する。
- `--tools '' --disallowedTools 'mcp__*' --strict-mcp-config --mcp-config '{"mcpServers":{}}'`でモデルへファイル読取・編集・シェル・Web等の権限を与えない。構造化出力用の `StructuredOutput` だけは必要な機能として残す。
- `--disable-slash-commands --permission-mode dontAsk --no-session-persistence --max-turns 1`を使用する。権限の追加承認や再開セッションは使わない。CLI組み込みのプラグイン・認証通信・テレメトリ等は、モデルに与える操作権限とは区別する。
- 環境変数はHOME・PATH・言語・一時領域・標準proxy/CA設定に限定する。APIキー・OAuthトークン変数・NODE_OPTIONS・provider overrideを継承しない。HOMEは公式CLIが自分でログインを解決するためにだけ使い、対象テストには別の空HOMEを渡す。
- 既知の認証パス（`.claude/`、`.codex/`、`.env*`、鍵等）を差分・明示した未追跡ファイル・テスト候補・隔離コピーから除外し、Issue入力にも使わせない。正解データの除外は維持する。これはパスによる除外で、ソースやIssueへ埋め込まれた任意の秘密を自動検知する機能ではない。送信入力には秘密を含めない。

## 上限・失敗・移行

profileは [version 2](requirement-planning.md#許可profile)。version 1と `endpoint` / `apiKeyEnv` は移行案内付きで拒否し、製品のHTTP接続とAPIキー解決は削除した。API方式へのフォールバックはない。

`maxRequests`はplan/runそれぞれのLatchによるCLI推論起動数の上限（1〜3）。planは1回、runは生成と修復の合計を数え、上限到達後は修復を追加しない。CLI内部のHTTP要求や構造化出力処理の回数と同義ではなく、利用量・費用の保証でもない。Latchは自動再試行しない。各起動の期限（1,000〜120,000ms）は版・認証確認も含む。入出力も制限し、タイムアウト・キャンセル・出力超過でプロセスグループを終了し一時領域を削除する。

CLI未導入、版や対応環境の不一致、未ログイン、認証失敗、利用上限、不正JSON/構造化出力、タイムアウト、キャンセルを区別して終了コード2で停止する。未知の失敗を推測で分類せず汎用の実行失敗にする。生のstdout/stderrやアカウント情報をエラーへ出さない。

## 検証と未実施の評価

通常テストは偽の `claude` 実行ファイルの固定応答を使い、実アカウントを使わず、同じプロセス境界を通す。correct/buggy・曖昧な要件・実行不能について、計画から隔離実行・両レポートまで確認する。これは実モデルの品質評価ではない。

未改変の公式CLIの起動確認は別に実行する:

```sh
LATCH_OFFICIAL_CLI=/absolute/path/to/claude \
  pnpm exec vitest run --project integration tests/integration/official-cli-startup.test.ts
```

このテストは新しい空HOMEを作り、実認証情報を使わない。ユーザー/プロジェクトのフックを仕込み、本番と同じ制限引数で有効ツールが `StructuredOutput` のみ、MCPなし、フック未実行、未ログイン停止であることを調べる。2026-10-26に2.1.310で成功した。組み込みプラグインが列挙されても、それらをモデルの操作ツールとして許可するものではない。通常CIは公式CLIの導入を要求せず、この任意テストをskipする。

実アカウントでのplan/run・敵対的入力への動作・生成品質・利用量の評価は、利用者指定のCLI・契約・要求数・時間・利用量上限が決まってから [全工程の評価手順](order-api-evaluation.md) で行う。旧1 USD API予算は流用しない。現在は指定待ち、実モデル要求0件。#81はこの未検証事項を残し、完了・自動closeしない。
