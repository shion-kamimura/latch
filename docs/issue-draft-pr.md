# IssueからDraft PRを作成する

GitHub Actionsの **Issue to Draft PR** を手動実行すると、IssueをOpenCode / DeepSeekで実装し、独立検証した変更をDraft PRにします。Latch CLIの検証機能とは別の開発自動化です。自動承認・自動マージはしません。

## 初期設定と実行

1. ワークフローをレビューしてmainへマージします。main以外からの起動は拒否します。
2. Repository Secret `DEEPSEEK_API_KEY` を設定します。Issue・ソースにキーを記載しません。
3. Actions設定の **Allow GitHub Actions to create and approve pull requests** を有効にします。使用するのは作成操作だけです。組織の制約は管理者が設定します。
4. **Issue to Draft PR** → **Run workflow** でmainと開いたIssue番号を指定します。実行者・再実行者はwrite / maintain / admin権限が必要です。Issue本文やラベルでは起動しません。
5. Draft PRの差分、検証結果、未検証事項をレビューします。テスト成功は要件全体の充足を証明しません。

`allow_maintenance` は旧呼び出しとの互換性のため残るboolean入力です。true / falseとも提案可能範囲は同じで、新しい起動時には指定不要です。#18 / PR #19の保守許可ゲートは #34で見直しました。変更後の権限やポリシーの適用承認ではありません。

## 安全境界と変更範囲

- 固定baseから取得した信頼したホストコードで制御します。候補の制御コード・Dockerfile・ワークフローを同じ実行に適用しません。
- AIと候補コードは非root・capabilityなし・read-only rootのコンテナ内だけで実行します。ホストのGit資格情報、APIキー、ホーム、Docker socket、Actions環境変数を渡しません。ホスト直接実行へのフォールバックはありません。
- リポジトリ全体の通常の変更を提案できます。`package.json`、lockfile、設定、`.github/`の下位ディレクトリ、`AGENTS.md`、fixture、`.patch`、YAML、シェルも含みます。
- パスは正規化した相対パスのみ。絶対パス、空要素、`.` / `..`、`.git`、バックスラッシュ、制御文字を拒否します。空白・日本語は許可し、表示はJSONエスケープします。
- 通常ファイルはUTF-8またはbase64で表現し、Gitモード100644 / 100755を保持します。内部symlinkは120000とリンク先で表現します。絶対・境界外・Gitメタデータへのリンクと循環リンクを拒否し、snapshot時にも実際のリンク解決を確認します。
- 変更済みファイルは各8 MiB、最大1,000件、公開JSONは32 MiBまでです。100件または1 MiB超は警告です。GitHub APIにも同じ上限を適用し、バイナリはblob APIを使います。既存の未変更ファイルはストリームでhashし、一律の件数・500 KB制限を適用しません。
- `node_modules`、`dist`、`coverage`、`__pycache__`、`.cache`、`.pnpm-store`は生成物として提出から除外します。検証後の提出ソースの変更は再検証なしに公開しません。
- `.env`の名前だけで拒否しません。ダミーの`.env.example`も扱えます。秘密鍵、既知のトークン形式、長い認証値の代入を内容検査し、base64も復号して検査します。検出器は任意の秘密情報を完全に検出する保証はありません。実秘密情報をfixtureへ置かないでください。
- `publish`は別runnerで提案をデータとして再検査してGit APIへ書き込みます。候補のコード・テスト・install scriptを実行しません。このジョブだけがcontents / pull-requestsのwrite権限を持ちます。GitHubや実行基盤の権限制約を迂回しません。

## 独立検証

Node.js 26.12.0 / pnpm 12.14.0 / OpenCode 1.19.3を固定しています。候補が改変したnode_modulesは検証へ引き継ぎません。候補のmanifest / lockfileから、別の依存準備コンテナで `pnpm install --frozen-lockfile --ignore-scripts` を実行します。baseイメージの依存を候補の検証に流用しません。

AIは設定済みのHTTPS proxyを介して公開npm registryだけへアクセスでき、pnpmで依存・lockfileを更新できます。依存準備はAPI中継にも接続しない別internal networkを使います。資格情報を持たない固定宛先トンネルは `registry.npmjs.org:443` だけへ接続し、任意ホスト・ポートを拒否します。metadataやlockfileのURLを書き換えません。private registryや任意URL依存は対象外です。トンネルは最大16接続、各5分、実行全体512 MiBの通信で制限します。

install時はlifecycleを無効にし、取得後に `pnpm rebuild --pending` をネットワークなしの隔離コンテナで実行します。pnpmのallowScripts設定は候補の設定に従い、スクリプトも未信頼として扱います。依存取得5分、script3分を上限とし、不整合・registry拒否・取得失敗・script失敗を固定ラベルで区別します。ホスト上でinstallを実行せず、候補設定から秘密情報・Docker socket・信頼した制御コードへは到達できません。

独立コンテナで `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm test`、`pnpm build` を実行します。CLI試験前にはbuildが必要です。AI / 検証コンテナはメモリ4 GiB、CPU 2、プロセス256、AI60分、各検証3分までです。implementジョブは90分です。

`AGENTS.md`または`.github/`が実際に変わった場合はPython追加検証を行います。変更前のテストは変更前のモジュールに対して実行し、候補テストは候補モジュールに対して別プロセスで実行します。古い許可リストを候補の仕様として強制しません。どちらも資格情報・ネットワークなしの非root・read-onlyコンテナで実行します。候補Pythonの成功は安全性の証明ではありません。変更後のワークフローやDocker buildは通常CI・レビューでも確認してください。

```sh
python3 -B -m unittest discover -s .github/automation -p 'test_*.py' -v
```

## API制限と診断

キーを持つ中継は固定DeepSeek APIだけへ接続し、リダイレクト・任意URL・任意モデルを許可しません。AIはinternal networkから中継へだけ接続します。モデルは `deepseek-flash`、thinking無効、出力8,192 tokens、context 1,000,000 tokensです。

| 項目     | 初期値                            |
| -------- | --------------------------------- |
| API要求  | 500回                             |
| 単発JSON | 1 MiB                             |
| 累積JSON | 256 MiB                           |
| 推定費用 | 実行ごと5 USD（未精算予約を含む） |
| AI時間   | 60分                              |

80%到達を警告します。送信前に最大contextと最大出力をピーク単価で予約し、usage取得後に精算します。欠測・送信後の不明な課金は予約を保持します。初期単価は100万tokensあたり入力hit 0.006 / miss 0.3 / 出力1.2 USDです。`LATCH_COST_CONFIG` は信頼したホスト設定のみで、`limit_usd`、`hit_usd_per_million`、`miss_usd_per_million`、`output_usd_per_million`の正の有限値を検証します。請求額の厳密保証ではありません。#28 / PR #29で採用したこの方式は #38で追加見直しします。

API失敗は `configuration_error`、`model_configuration_error`、`api_error`、`timeout`、`abnormal_exit`等の固定ラベルで報告します。中継はHTTP statusと回数・usage・推定費用・未精算予約・警告を記録します。認証情報、送受信本文、生transcript、例外詳細は公開しません。`diagnostics_available=false`やusageのnullは不明であり、使用量ゼロを意味しません。OpenCodeの自動圧縮・pruningを有効にし、取得できた件数だけ記録します。

制限は実行単位です。再実行・別Issue・月間費用は別途管理してください。APIキーは中継だけへ渡し、AIのソースやIssue本文から予算を変更できません。

## 公開と失敗時の扱い

同一Issueはconcurrencyで直列化します。`feat/automated-<Issue node IDのSHA-256先頭16文字>`に提案します。現段階では既存PRは更新せず、main更新時は停止します（#37で見直し）。

独立チェック失敗時は現段階では提案を公開しません（#36で見直し）。提案artifactは1日、数値・固定ラベルの診断は成功・失敗とも14日保持します。runner強制終了時は保存できない場合があります。安全検査に失敗した変更を公開せず、意味的なIssue整合・全受け入れ条件・生成テストの妥当性は人間のレビューに残します。

`GITHUB_TOKEN`で作成するPRは通常のPR CIを自動起動しません。独立検証結果を確認し、必要なら人間がブランチを更新してCIを起動してください。PAT追加・権限拡大は行いません。

## 実試験と過去の実行

モック合格を実API・実GitHub書き込みの確認と混同しません。有料API・Actions実試験は範囲・予算を決めて別に実施し、未実行なら未検証と記録します。

実行39779457307は旧`forbidden_path`で停止しましたが、具体的な拒否ファイルは未特定です。通常の設定・差分データが通る回帰テストを追加しても、元実行の原因を再現済みとは扱いません。

[DeepSeek料金・仕様](https://api-docs.deepseek.com/quick_start/pricing/) / [OpenCode設定](https://opencode.ai/docs/config/) / [GitHubトークンによるイベント](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
