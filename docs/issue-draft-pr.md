# IssueからDraft PRを作成する

GitHub Actionsの **Issue to Draft PR** を手動実行すると、IssueをOpenCode / DeepSeekで実装し、独立検証した変更をDraft PRにします。Latch CLIの検証機能とは別の開発自動化です。自動承認・自動マージはしません。

## 初期設定と実行

1. ワークフローをレビューしてmainへマージします。main以外からの起動は拒否します。
2. Repository Secret `DEEPSEEK_API_KEY` を設定します。Issue・ソースにキーを記載しません。
3. Actions設定の **Allow GitHub Actions to create and approve pull requests** を有効にします。使用するのは作成操作だけです。組織の制約は管理者が設定します。
4. **Issue to Draft PR** → **Run workflow** でmainと開いたIssue番号を指定します。実行者・再実行者はwrite / maintain / admin権限が必要です。Issue本文やラベルでは起動しません。
5. Draft PRの差分、検証結果、未検証事項をレビューします。テスト成功は要件全体の充足を証明しません。

`allow_maintenance` は旧呼び出しとの互換性のため残るboolean入力です。true / falseとも提案可能範囲は同じで、新しい起動時には指定不要です。#18 / PR #19の保守許可ゲートは #34で見直しました。変更後の権限やポリシーの適用承認ではありません。

### 自動生成PRのタイトル

手動・AI作成と同じ [命名規則](../AGENTS.md) に従い、`<type>: <具体的な変更内容>` を使います。実装エージェントが最終差分の主目的から `feat`・`fix`・`docs`・`refactor`・`test`・`ci`・`chore` を選びます。例は `docs: Issue登録時の追加承認を不要にする`、`fix: 未対応引数で終了コード1を返す`、`feat: PRの要件を抽出する` です。Issueの種別接頭辞やブランチの `feat/automated-...` からtypeを固定しません。Conventional Commitsの形式をPRタイトルにも採用する本リポジトリの方針です。

エージェントは変更の主目的が定まった時点で、既存の無視対象である `dist/latch-pr-title.json` に `{"title": "docs: 利用仕様を明文化する"}` のようなJSONオブジェクトを出力し、実装・テスト後には部分成果の場合も更新します。このファイルはソース差分に含めず、新たな許可パス・mount・権限を追加しません。ホストは通常ファイル、symlinkなし（親の `dist` を含む）、最大4,096 bytes、`title` キーのみという条件で読み、独立検証前にタイトルを検査して保持します。検証が失敗した部分成果も含め、`proposal.json` に `pr_title` として保存し、公開処理は最初のGitHub書き込み前に同じ検査を再実行します。独立チェックが生成するビルド成果物からは読み直しません。

タイトルは256文字以内の1行で、対応するtype、区切りの `: `、前後に空白のない具体的な説明が必要です。欠落・空の説明・未対応type・改行・制御文字・`implement Issue #番号` やIssue番号だけの説明は `invalid_pr_title` で停止し、代替の `feat` タイトルには置き換えません。Issueタイトル・本文や生成タイトルはデータとして扱い、シェル・コード・ワークフローの命令に展開しません。タイトルはGitHub APIのJSON文字列として渡し、自動コミットの先頭行にも使用します。PR本文のIssue紐づけと実際の検証結果・未検証事項を維持し、要求変更・終了時は既存の `Refs #番号` 方針に従います。タイトルのIssue番号は必須にしません。タイトルが欠落・不正な場合も、安全検査を通ったソースとチェック結果はartifactへ残し、公開時の検査でGitHub書き込みを停止します。秘密情報のパターンを含むタイトルも拒否します。

形式検査はtypeの選択や説明と差分の意味的な一致を保証しません。人間がレビューしてください。API予算・隔離・独立チェック・ブランチ所有権・再実行の仕組みは維持します。

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

キーを持つ中継は固定DeepSeek APIだけへ接続し、リダイレクト・任意URL・任意モデルを許可しません。AIはinternal networkから中継へだけ接続します。信頼したbaseの `Dockerfile.gateway` が固定したtransformers / tokenizersを導入します。候補のイメージやPythonを中継へ適用しません。

| 項目                 | 初期値                                    |
| -------------------- | ----------------------------------------- |
| 推定費用             | 実行ごと5 USD（未精算予約を含む）         |
| AI時間               | 60分                                      |
| API要求              | 異常反復の最終停止10,000回                |
| 単発JSON / 応答      | 各16 MiB（メモリ保護）                    |
| 累積JSON             | 256 MiB到達で警告、超過だけでは停止しない |
| モデルcontext / 出力 | 1,000,000 / 8,192 tokens                  |
| thinking             | disabled（初期値）                        |

10,000回は旧500回の20倍で、60分全体に平均約2.8要求/秒が必要な最終ストッパーです。通常の146回程度の反復を回数だけで止めません。単発上限は1M contextの多言語・tool定義を収めやすい16 MiBへ広げ、応答も別に16 MiBで制限します。あらゆる正当な入力サイズの保証ではなく、メモリ保護の上限です。費用・時間は増やしません。#28 / PR #29の累積JSONハード停止・全要求の最大context予約は #38で見直しました。

送信前の予約は、利用できる場合、次の根拠に基づきます。

1. 運用者が固定・互換性確認した公式tokenizerとchat templateで、messages、roles、tools、生成prefix、thinking設定を含めて計測する。
2. 完全に同一の正規化した要求を以前送信済みなら、そのAPIが報告したprompt_tokensを再利用する。本文そのものは保存せずSHA256と数値だけ保持する。
3. tokenizer未設定・非対応・計測不能なら、モデル最大contextを全cache missとして予約する。根拠のないbytes/token換算を使わない。

初期料金は100万tokensあたり入力hit 0.006 / miss 0.3 / 出力1.2 USDです。計測した入力と設定された最大出力をピーク単価で予約し、usage取得後に精算します。計測とAPI usageが食い違った場合は観測費用へ精算して以後の送信を停止します。API aliasやprovider内部templateの変更まで固定できないため、**推定額の停止条件であり請求額の厳密保証ではありません**。

tokenizerは既定では未配置です。運用者は対象aliasと互換性を確認した公式snapshotをホストへ準備し、`LATCH_TOKENIZER_DIRECTORY` と `LATCH_TOKENIZER_SHA256` を設定します。fingerprintは全通常ファイルを相対パス順に、パスUTF-8＋NUL＋内容をSHA256へ順次入力した値です。symlink・各64 MiB超を拒否し、read-onlyで中継だけへmountします。`local_files_only=True`、`trust_remote_code=False`で読み込み、リポジトリ候補やIssueからtokenizerやtemplateを取得しません。実モデルとの互換性・公式artifact選定は今回未検証です。未配置時は保守的な最大context予約へ戻るため、異なる小要求の予約削減はtokenizer導入後に確認が必要です。

usage欠測、不正応答、送信後timeout、HTTP 5xx、不明な通信失敗は予約を保持します。認証・入力・レート制限のHTTP 400/401/403/404/422/429、およびDNS失敗・connection refusedはcompletion前の拒否として予約を解放します。送信試行数・通信量は観測として残します。欠測を無料と扱いません。

`LATCH_COST_CONFIG` は信頼したホスト設定のみで、`limit_usd`、`hit_usd_per_million`、`miss_usd_per_million`、`output_usd_per_million`を検証します。`LATCH_MODEL_CONFIG`も信頼したホストだけが設定し、次の初期値を使います。

```json
{
  "model": "deepseek-flash",
  "context_tokens": 1000000,
  "output_tokens": 8192,
  "thinking": "disabled",
  "requests": 10000
}
```

context・出力は上表のモデル上限以内、thinkingはenabled / disabled、回数は100〜100,000の整数を検証します。任意モデル・URL・単価・費用増額をAIのリクエストから受け付けません。モデル機能・出力と費用の境界を分けます。数値・累積量・予約費用の80%到達は警告で、回数・単発・費用・時間のハード停止とは区別します。

診断には適用モデル設定、count_basis（tokenizer / identical_request_usage / model_context_fallback）、usage、推定費用、未精算予約、警告、停止理由を記録します。モック比較ではusage欠測の小要求100件に対し、旧最大context予約は16件で停止、計測入力20 tokensの新予約は100件継続し、不明費用の予約も保持しました。累積300 MiBも費用内で継続します。この比較はtokenizerの実モデル互換性や実API完了率の確認ではありません。

API失敗は `configuration_error`、`model_configuration_error`、`api_error`、`timeout`、`abnormal_exit`等の固定ラベルで報告します。中継はHTTP statusと回数・usage・推定費用・未精算予約・警告を記録します。認証情報、送受信本文、生transcript、例外詳細は公開しません。`diagnostics_available=false`やusageのnullは不明であり、使用量ゼロを意味しません。OpenCodeの自動圧縮・pruningを有効にし、取得できた件数だけ記録します。

制限は実行単位です。再実行・別Issue・月間費用は別途管理してください。APIキーは中継だけへ渡し、AIのソースやIssue本文から予算を変更できません。

## 公開と失敗時の扱い

同一Issueはconcurrencyで直列化します。`feat/automated-<Issue node IDのSHA-256先頭16文字>`に提案します。bot作成のDraft PRとIssue node IDの所有マーカー、bot先端コミット、prepareで観測したheadを照合し、継続をfast-forwardで反映します。ハッシュ名だけでは所有を認めません。人間のコミットが混ざった場合は、そのスナップショットを入力にした別ブランチ `-r<run ID>-a<attempt>` へ提案し、元PRを上書きしません。閉じたPR後も新しい実行サフィックスへ再提案できます。

制御コードは実行開始時のmainへ固定し、継続の対象コードは既存headへ固定します。公開commitは検証した入力commitを親とするため、実行中にmainが進んでも成果を残せます。最新mainとの統合は未検証として明記し、自動rebaseによる検証結果の流用は行いません。元の要求は1日保持のrequest artifactとSHA256識別情報で追跡します。Issueの空白編集はformat_only、その他の変更は保守的にchanged、終了はclosedと記録し、後二者はClosesではなくRefsとして保存して現行要件の達成を主張しません。

公開はproposal識別情報をcommitへ記録し、同じartifactによるPR API失敗後の再試行を冪等に扱います。prepareで再度権限・Issue同一性を確認し、ブランチ先端変更はforce=falseで拒否します。並行更新競合時の成果はartifactに残り、再実行で最新先端から継続します。PR作成が競合した場合は同じ所有マーカーのDraft PRを照合します。

テスト失敗、環境不足、AI非ゼロ終了、タイムアウト、予算停止でも、候補コンテナ停止後に同じ安全検査を行い、安全な部分成果を提案artifactとDraft PRに残します。成功・失敗・timeout・未実行・環境不足をschema v2で区別し、実装状態も別記します。未完了時のimplementジョブは失敗のまま、publishを安全なartifactの存在で起動します。独立チェックは可能な範囲で継続します。既定test内でbuildが成功したときは重複buildを行わずcovered_by_testと記録します。PR見出しの完全一致は要求せず、Issueリンクと実結果を保持します。

安全検査に失敗した候補は公開しません。policy.jsonに固定理由、秘密パターンを秘匿したJSONエスケープ済み拒否パス、次の対応を残します。生transcript・生の検証出力は一時領域から外へ出しません。公開するエラー要約は分類と終了コードです。任意ログの完全な秘匿は保証できないため、全文ログの無条件保存は行いません。

提案artifactはアクセス権のあるリポジトリ利用者が参照でき、1日保持します。数値・固定ラベル・安全な拒否パスの診断は成功・失敗とも14日保持します。Actionsからartifactを確認し、失敗したチェックを修正して再実行します。runner強制終了時は保存できない場合があります。安全検査に失敗した変更を公開せず、意味的なIssue整合・全受け入れ条件・生成テストの妥当性は人間のレビューに残します。

`GITHUB_TOKEN`で作成するPRは通常のPR CIを自動起動しません。独立検証結果を確認し、必要なら人間がブランチを更新してCIを起動してください。PAT追加・権限拡大は行いません。

## 実試験と過去の実行

モック合格を実API・実GitHub書き込みの確認と混同しません。有料API・Actions実試験は範囲・予算を決めて別に実施し、未実行なら未検証と記録します。

実行39779457307は旧`forbidden_path`で停止しましたが、具体的な拒否ファイルは未特定です。通常の設定・差分データが通る回帰テストを追加しても、元実行の原因を再現済みとは扱いません。

[DeepSeek料金・仕様](https://api-docs.deepseek.com/quick_start/pricing/) / [OpenCode設定](https://opencode.ai/docs/config/) / [GitHubトークンによるイベント](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
