# 公式CLIへの移行調査（#81）

状態: 調査中・接続置換は未実装。[Issue #81](https://github.com/shion-kamimura/latch/issues/81) の完了記録ではない。2026-10-26、main `3ac17e0` を基準に確認した。旧API接続は現行コードに残り、公式CLIの採用・旧設定の拒否・CLI固定応答への置換・実利用評価は未完了である。

## 責務と採用条件

[製品方針](product-vision.md#自前実装を最小化する原則) に従い、認証・通信・資格情報管理・非対話のモデル実行を公式ツールへ委譲する。Latchは入力の固定と送信許可、生成結果と出典の検証、隔離実行、要件・テスト・証拠のレポートを持つ。JSON出力が得られても、Latch固有の出典・条件ID・証拠の妥当性はLatchで検証する必要がある。

採用前に、ログインを利用したまま不要なファイル読取・編集・コマンド・ネットワーク・ツールを制限できることを確認する。正解データや資格情報を渡さず、対象ワークツリーを変更しない。プロンプトの禁止文だけでは採用条件を満たさない。認証ファイルの探索・読取・コピー、独自認証、非公開API、ブラウザ自動ログイン、APIキーへのフォールバックは実装しない。

## 公式情報と比較

以下は2026-10-26に取得した公式資料と、導入済みまたは調査用に導入した未改変CLIのヘルプに基づく。ドキュメントの将来の変更や別バージョンへ結果を一般化しない。

| 項目         | Codex CLI                                                                                                                         | Claude Code                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 確認版       | 環境の `codex-cli 0.163.0`                                                                                                        | 調査用 `2.1.310 (Claude Code)`                                                                                       |
| 非対話       | `codex exec`、stdin、`--ephemeral`                                                                                                | `claude -p`、stdin、`--no-session-persistence`                                                                       |
| 構造化出力   | `--output-schema` と `--json`                                                                                                     | `--json-schema` と `--output-format json`、`structured_output`                                                       |
| 制御候補     | read-only sandbox、`--ignore-user-config`、`--ignore-rules`、`features.shell_tool`、web search等の設定                            | `--tools ""`、`--disallowedTools "*"`、`--strict-mcp-config`、`--restricted`、`--safe-mode`                          |
| 未解決の境界 | read-onlyは読取禁止ではなく、シェル無効化も全ツールの無効化とは同義でない。モデルが持つ編集ツール等も含めた有効な権限の実証が必要 | managed hooks等は通常の無効化を越えて残る。`--bare`はOAuthログインを利用しないため、本件のログイン委譲とは両立しない |
| 今回の判断   | 未採用                                                                                                                            | 全ツール無効化が明示されるため先に調査したが、管理者設定を含む境界が未実証のため未採用                               |

Codexの公式資料:

- [認証と契約](https://developers.openai.com/codex/auth)
- [非対話実行](https://developers.openai.com/codex/noninteractive)
- [CLI参照](https://developers.openai.com/codex/cli/reference)
- [設定参照](https://developers.openai.com/codex/config-reference)
- [公式ソースのツール構成](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs): 調査時点のmainではシェルの登録と、モデルの能力によるApplyPatch登録が別である。環境の0.163.0と同一revisionの実測ではないため、この読取だけで同版の権限を確定しない。

Claude Codeの公式資料:

- [CLI参照](https://code.claude.com/docs/en/cli-reference): `--tools`は組み込みツールを限定する。MCPは別に限定する必要がある。`--safe-mode`でもpolicy-configured hooks等が残る。
- [非対話実行と構造化出力](https://code.claude.com/docs/en/headless)
- [認証](https://code.claude.com/docs/en/authentication): 利用者の公式ログインと認証方式の優先順位。`claude auth status`が返す状態はキーの存在と区別する。
- [disableAllHooks](https://code.claude.com/docs/en/settings-reference#disableallhooks): 「Only managed settings can disable managed hooks.」利用者側の設定で全フックを停止したとは扱わない。
- [法的条件と資格情報の利用](https://code.claude.com/docs/en/legal-and-compliance): 未改変バイナリを利用者自身の契約で使う場合と、第三者製品が利用者に代わって月額資格情報で要求を中継する場合を区別する。ログイン機能の提供やトークンの収集・中継は行わない。

月額プランでの一般利用が許可されるとは断定しない。採用する方式・実行主体・契約・利用上限を公式条件と照合し、解消できない場合は提供元への確認を必要とする。利用者の契約変更や管理者設定の変更は本実装の範囲に含めない。

## 実施した確認と限界

- `codex --version`・`codex exec --help`、Claude Code 2.1.310の `--version`・`--help` で上記の非対話・権限制御のフラグを確認した。モデル要求は送っていない。
- Claude Codeを対象リポジトリ外の空の作業ディレクトリ、調査用の空のHOMEで起動し、`--restricted --setting-sources '' --settings '{"disableAllHooks":true}' auth status` が `loggedIn: false`・`authMethod: none` を返すことを確認した。実アカウントの認証ファイルは読んでいない。
- managed hooksが残ることと、`--bare`がOAuth/keychainを読まないことを公式資料・ヘルプで確認した。ログインと必要な制限を同時に満たす実利用は確認していない。
- CLI呼び出しと固定応答の試作は採用していない。試作のテスト結果を現行製品の保証や公式CLIの権限検証として扱わない。

Node.js 26.12.0・pnpm 12.14.0で `pnpm install --frozen-lockfile` を完了した。初期の通常サンドボックスではproxy接続と子プロセス実行が失敗したが、実行プラットフォームの明示的な権限指定で調査を続けた。これは製品CLIへ追加権限を与える設計判断ではない。

## 再開条件と残作業

1. 公式ログインと必要な権限制限を両立する方式を1つ選び、対応版を固定する。ユーザー設定・プロジェクト設定・管理者設定・フック・MCP・プラグインを含む有効な権限を検証し、必要な境界を確保できなければ採用しない。管理者設定や認証を迂回しない。
2. 採用版の実バイナリで、入力にファイル読取・編集・コマンド実行・通信を要求しても実行されないことを確認する。送信済みの明示入力以外を収集せず、正解データ非送信・ワークツリー不変・対象テストへの資格情報非継承を検証する。
3. 最小の呼び出し層を実装し、旧HTTP接続・キー解決・API専用設定を削除する。旧profileは移行案内付きで拒否する。CLI未導入・未ログイン・不正出力・利用上限・タイムアウト・キャンセルを区別し、生のエラーや資格情報を出力しない。
4. CLIの固定応答で、要件抽出から隔離実行・テキスト/JSONレポートまでを検証する。Latchの要求上限、CLI内部の再試行・構造化出力用要求、プロセス全体の期限と子プロセス終了を区別して記録する。
5. 利用者指定のCLI・契約・要求数・時間・利用量上限を確認してから、[全工程の評価手順](order-api-evaluation.md) の実利用評価を実施する。旧1 USD API予算は流用しない。現在は指定待ちで、実モデル要求は0件。

全条件を満たすまでは #81 を完了・自動closeしない。次回はIssue・この比較・最新default branch・`git status --short` を確認し、依存を準備する。この変更は文書のみで、接続実装・テスト・認証・Secrets・契約・管理者設定を変更していない。
