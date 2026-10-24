# IssueからDraft PRを作成する

GitHub Actionsの **Issue to Draft PR** を手動実行すると、IssueをOpenCode / DeepSeekで実装し、独立検証した変更をDraft PRにします。Latch CLIの検証機能とは別の開発自動化です。自動承認・自動マージはしません。

責務の委譲・維持の判断、入出力契約、キャッシュ・検証再実行・修復の段階的移行は [自動実装の委譲設計](automation-delegation.md) に記録しています。以下は現行の運用手順です。後続設計を実装済みの機能として扱わないでください。

## 初期設定と実行

1. ワークフローをレビューしてmainへマージします。main以外からの起動は拒否します。
2. Repository Secret `DEEPSEEK_API_KEY` を設定します。Issue・ソースにキーを記載しません。
3. Actions設定の **Allow GitHub Actions to create and approve pull requests** を有効にします。使用するのは作成操作だけです。組織の制約は管理者が設定します。
4. **Issue to Draft PR** → **Run workflow** でmainと開いたIssue番号を指定します。実行者・再実行者はwrite / maintain / admin権限が必要です。Issue本文やラベルでは起動しません。
5. Draft PRの差分、検証結果、未検証事項をレビューします。テスト成功は要件全体の充足を証明しません。

通常実行の入力はIssue番号だけです。設定・依存・CI・開発ルールを含む従来の変更範囲を、追加の保守許可なしにDraft PRへ提案できます。#18 / PR #19の保守許可ゲートは #34で見直し、`allow_maintenance` 入力も削除しました。PRのマージ、権限・Secrets変更、実行中の安全境界の変更への許可ではありません。

旧dispatch呼び出しは `allow_maintenance` の指定を削除してください。GitHub CLIでは `-f allow_maintenance=...` や `-F allow_maintenance=...` を除き、例えば `gh workflow run issue-draft-pr.yml --ref main -f issue_number=51` とします。REST APIのdispatchでは `inputs` から同キーを除き、`{"ref":"main","inputs":{"issue_number":"51"}}` のように送ります。過去のrequest artifactに含まれる任意のbooleanフィールド `allow_maintenance` は引き続き受理しますが、true / false / 省略で提案可能範囲は変わりません。これは削除済みのdispatch入力を引き続き送れるという意味ではありません。

### 自動生成PRのタイトル

手動・AI作成と同じ [命名規則](../AGENTS.md) に従い、`<type>: <具体的な変更内容>` を使います。実装エージェントが最終差分の主目的から `feat`・`fix`・`docs`・`refactor`・`test`・`ci`・`chore` を選びます。例は `docs: Issue登録時の追加承認を不要にする`、`fix: 未対応引数で終了コード1を返す`、`feat: PRの要件を抽出する` です。Issueの種別接頭辞やブランチの `feat/automated-...` からtypeを固定しません。Conventional Commitsの形式をPRタイトルにも採用する本リポジトリの方針です。

エージェントは変更の主目的が定まった時点で、既存の無視対象である `dist/latch-pr-title.json` に `{"title": "docs: 利用仕様を明文化する"}` のようなJSONオブジェクトを出力し、実装・テスト後には部分成果の場合も更新します。このファイルはソース差分に含めず、新たな許可パス・mount・権限を追加しません。ホストは通常ファイル、symlinkなし（親の `dist` を含む）、最大4,096 bytes、`title` キーのみという条件で読み、独立検証前にタイトルを検査して保持します。検証が失敗した部分成果も含め、`proposal.json` に `pr_title` として保存し（分離経路では先に候補bundleへ保存）、公開処理は最初のGitHub書き込み前に同じ検査を再実行します。独立チェックが生成するビルド成果物からは読み直しません。

タイトルは256文字以内の1行で、対応するtype、区切りの `: `、前後に空白のない具体的な説明が必要です。欠落・空の説明・未対応type・改行・制御文字・`implement Issue #番号` やIssue番号だけの説明は `invalid_pr_title` で停止し、代替の `feat` タイトルには置き換えません。Issueタイトル・本文や生成タイトルはデータとして扱い、シェル・コード・ワークフローの命令に展開しません。タイトルはGitHub APIのJSON文字列として渡し、自動コミットの先頭行にも使用します。PR本文のIssue紐づけと実際の検証結果・未検証事項を維持し、要求変更・終了時は既存の `Refs #番号` 方針に従います。タイトルのIssue番号は必須にしません。従来の一体経路ではタイトルが欠落・不正な場合も、安全検査を通ったソースとチェック結果はartifactへ残し、公開時の検査でGitHub書き込みを停止します。新しい分離経路では、不正タイトルの場合は再開用候補bundleも作成せず、policy診断を残して停止します。秘密情報のパターンを含むタイトルも拒否します。

形式検査はtypeの選択や説明と差分の意味的な一致を保証しません。人間がレビューしてください。API予算・隔離・独立チェック・ブランチ所有権・再実行の仕組みは維持します。

## 安全境界と変更範囲

- 固定baseから取得した信頼したホストコードで制御します。候補の制御コード・Dockerfile・ワークフローを同じ実行に適用しません。
- AIと候補コードは非root・capabilityなし・read-only rootのコンテナ内だけで実行します。ホストのGit資格情報、APIキー、ホーム、Docker socket、Actions環境変数を渡しません。ホスト直接実行へのフォールバックはありません。
- リポジトリ全体の通常の変更を提案できます。`package.json`、lockfile、設定、`.github/`の下位ディレクトリ、`AGENTS.md`、fixture、`.patch`、YAML、シェルも含みます。
- パスは正規化した相対パスのみ。絶対パス、空要素、`.` / `..`、`.git`、バックスラッシュ、制御文字を拒否します。空白・日本語は許可し、表示はJSONエスケープします。
- 通常ファイルはUTF-8またはbase64で表現し、Gitモード100644 / 100755を保持します。内部symlinkは120000とリンク先で表現します。絶対・境界外・Gitメタデータへのリンクと循環リンクを拒否し、snapshot時にも実際のリンク解決を確認します。
- 変更済みファイルは各8 MiB、最大1,000件、公開JSONは32 MiBまでです。100件または1 MiB超は警告です。GitHub APIにも同じ上限を適用し、バイナリはblob APIを使います。既存の未変更ファイルはストリームでhashし、一律の件数・500 KB制限を適用しません。hash読取総量は2 GiBまでです。
- `node_modules`、`dist`、`coverage`、`__pycache__`、`.cache`、`.pnpm-store`、`.eslintcache`、`.prettiercache`、`*.tsbuildinfo`は生成物として提出から除外します。検証後の提出ソースの変更は再検証なしに公開しません。
- `.env`の名前だけで拒否しません。ダミーの`.env.example`も扱えます。秘密鍵、既知のトークン形式、長い認証値の代入を内容検査し、base64も復号して検査します。検出器は任意の秘密情報を完全に検出する保証はありません。実秘密情報をfixtureへ置かないでください。
- `publish`は別runnerで提案をデータとして再検査してGit APIへ書き込みます。候補のコード・テスト・install scriptを実行しません。このジョブだけがcontents / pull-requestsのwrite権限を持ちます。GitHubや実行基盤の権限制約を迂回しません。

## 独立検証

Node.js 26.12.0 / pnpm 12.14.0 / OpenCode 1.19.3を固定しています。候補が改変したnode_modulesは検証へ引き継ぎません。候補のmanifest / lockfileから、別の依存準備コンテナで `pnpm with current install --frozen-lockfile --ignore-scripts --ignore-pnpmfile` を実行します。baseイメージの依存を候補の検証に流用しません。依存準備と独立検証はAI実装とは別jobで実行し、保存した同一候補を入力にします。

AIは設定済みのHTTPS proxyを介して公開npm registryだけへアクセスでき、pnpmで依存・lockfileを更新できます。依存準備はAPI中継にも接続しない別internal networkを使います。資格情報を持たない固定宛先トンネルは `registry.npmjs.org:443` だけへ接続し、任意ホスト・ポートを拒否します。metadataやlockfileのURLを書き換えません。private registryや任意URL依存は対象外です。トンネルは最大16接続、各5分、実行全体512 MiBの通信で制限します。

install時はlifecycleを無効にし、取得後に `pnpm rebuild --pending` をネットワークなしの隔離コンテナで実行します。pnpmのallowBuilds設定は候補の設定に従い、スクリプトも未信頼として扱います。依存取得5分、script3分を上限とし、不整合・registry拒否・取得timeout・その他取得失敗・install設定失敗・script失敗を固定ラベルで区別します。取得の通信失敗だけ最大1回再試行し、内部のfetch retryは無効にします。不整合、設定不正、registry拒否、lifecycle失敗は再試行しません。ホスト上でinstallを実行せず、候補設定から秘密情報・Docker socket・信頼した制御コードへは到達できません。

独立コンテナで `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm test`、`pnpm build` を実行します。CLI試験前にはbuildが必要です。AI / 検証コンテナはメモリ4 GiB、CPU 2、プロセス256、AI60分、各検証3分までです。implementジョブは90分、独立検証jobは30分です。

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

テスト失敗、環境不足、AI非ゼロ終了、タイムアウト、予算停止でも、候補コンテナ停止後に同じ安全検査を行い、安全な部分成果を提案artifactとDraft PRに残します。成功・失敗・timeout・未実行・環境不足を候補に結合したproposal schema v3で区別し、実装状態も別記します。AI未完了時のimplementとチェック失敗時のverifyは失敗のまま、安全な候補・結合済み結果の存在で後続jobを起動します。独立チェックは可能な範囲で継続します。既定test内でbuildが成功したときは重複buildを行わずcovered_by_testと記録します。PR見出しの完全一致は要求せず、Issueリンクと実結果を保持します。

安全検査に失敗した候補は公開しません。policy.jsonに固定理由、秘密パターンを秘匿したJSONエスケープ済み拒否パス、次の対応を残します。生transcript・生の検証出力は一時領域から外へ出しません。公開するエラー要約は分類と終了コードです。任意ログの完全な秘匿は保証できないため、全文ログの無条件保存は行いません。ホストの生ログは各16 MiBのfile-size上限、Dockerのlocalログは各10 MiB×2世代で制限します。ログ上限超過も正常完了にせず、安全な部分成果の経路へ進めます。

提案artifactはアクセス権のあるリポジトリ利用者が参照でき、1日保持します。数値・固定ラベル・安全な拒否パスの診断は成功・失敗とも14日保持します。Actionsからartifactを確認し、失敗したチェックを修正して再実行します。runner強制終了時は保存できない場合があります。安全検査に失敗した変更を公開せず、意味的なIssue整合・全受け入れ条件・生成テストの妥当性は人間のレビューに残します。

`GITHUB_TOKEN`で作成するPRは通常のPR CIを自動起動しません。共通の独立検証jobの結果を確認し、必要なら下記の検証専用workflowから保存候補を再検証してください。PAT追加・権限拡大は行いません。

## 実試験と過去の実行

モック合格を実API・実GitHub書き込みの確認と混同しません。有料API・Actions実試験は範囲・予算を決めて別に実施し、未実行なら未検証と記録します。

実行39779457307は旧`forbidden_path`で停止しましたが、具体的な拒否ファイルは未特定です。通常の設定・差分データが通る回帰テストを追加しても、元実行の原因を再現済みとは扱いません。

[DeepSeek料金・仕様](https://api-docs.deepseek.com/quick_start/pricing/) / [OpenCode設定](https://opencode.ai/docs/config/) / [GitHubトークンによるイベント](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)

横断確認の具体的な結果と未検証事項は [#32分割実装と横断検証の記録](ai-development-validation.md) を参照してください。

### 工程別の診断と失敗時の確認（#54）

run-nameには入力Issue番号を表示します。コミット題名は対象Issueの識別には使いません。implementのJob Summaryと `issue-diagnostics-<run ID>-<attempt>` Artifactで、制御base、検証source、候補snapshotと差分のSHA-256、実行attemptを照合できます。digestは候補のパス・内容hash・mode（差分では削除も含む）を正規化して計算し、要求充足の証明には使いません。

`dependency_fetch` はpnpmのfrozen lockfile照合・解決・取得を含む一つのinstall工程（300秒）、`dependency_lifecycle` はnetwork noneのrebuild（180秒）です。pnpm内部の解決と取得を別プロセスとして計測するものではありません。各独立チェックは180秒、AIプロセスは3600秒です。各工程の開始・終了時刻、経過ms、制限、終了コード、固定分類を記録し、実行中は30秒ごとにActionsログへ経過を出します。取得timeoutとlifecycle timeoutは別のstageの `timeout / time_limit`、チェック非ゼロ終了は `failed / exit_code` です。取得失敗はlockfile不整合・registry拒否・その他取得失敗、script失敗は `install_script_failed` に分類します。

失敗した工程を確認し、SummaryのNextと未実行理由を見て再試行対象を決めます。全jobの再実行はAIも再実行します。保存候補の検証だけを再実行する手順は下記の#56節を参照してください。依存準備不能なら主要チェックは `not_run / dependencies_unavailable`、変更なしなら `not_run / no_changes`、test内でbuild済みなら `not_run / covered_by_test` です。正常なAIプロセス終了、独立チェック成功、要求充足（未確認）は別々に判断します。

公開範囲と上限:

- 生のstdout/stderrは工程別の一時ファイルに分離し、各16 MiBを子プロセスのファイル上限で制限します。取得・lifecycle・各チェックは互いのログを上書きしません。生ログはrunnerの一時領域だけに置き、Artifact、Summary、PRへ転送しません。
- 公開する工程診断は信頼したホストが作る固定項目のみです。工程ごとに4 KiB以下の `stages/*.safe.json` を保存します。候補コード、Issue本文、コマンド引数、パス、API本文、URL、headers、例外本文を含めず、任意文字列の正規表現置換による秘匿には依存しません。
- 工程診断とSummary、既存のAPI診断・policyは14日保存、requestとproposalは従来どおり1日です。Actionsログ・Summary・Artifactはリポジトリの閲覧権限に従い、publicでは公開情報として扱います。Actionsログ・Summaryの保持期間はGitHub側のリポジトリ設定に従い、Artifactの14日設定とは別です。
- API記録はAI実行中も30秒間隔で固定項目だけを出力します。Dockerログの発生時刻 `occurred_at` と、ホストが出力した時刻 `emitted_at`、`mode=live/replay` を区別します。最終API集計は既存の最大100,000件の固定項目を保存し、工程別4 KiB制限とは別です。時刻は実行順序の参考で、厳密な因果関係の証明ではありません。

通常の非ゼロ終了・timeoutでもfinallyで工程診断とSummaryを保存し、`always()`でArtifactへ転送します。runner強制終了、キャンセル、ディスク障害では保存できない場合があります。診断が欠損した場合は成功と推定せず、Actions標準ログを確認してください。ローカル境界試験はモックのDocker/APIと実際の小さな子プロセスを使用し、実Actions・実DeepSeek・実pnpmネットワーク取得での確認とは区別します。

### AI前の依存事前確認とstoreキャッシュ（#55）

API中継の作成・起動とAI API呼び出しより前に、固定base（制御checkoutのHEAD）を別ディレクトリへexportします。継続sourceやAI候補からは事前確認の入力を作りません。

1. `base_dependency_runtime`（30秒）でNode 26.12.0、実pnpm 12.14.0、manifestの `packageManager: pnpm@12.14.0` の一致を確認します。`pnpm with current` はmanifest / devEnginesによる別pnpmの自動取得を避けます。候補も `dependency_runtime` で同じ確認を行います。異なる版の採用は固定imageの変更とレビューが必要です。
2. `dependency_probe`（90秒）は同じimage・ユーザー・internal network・固定registry中継を使い、空の一時storeへ `pnpm with current store add is-number@7.0.0` を実行します。コードを実行せず、warm時にもmetadata・tarballを最小取得して接続経路を確認します。
3. `base_dependency_fetch`（各300秒、通信失敗だけ最大2試行）は候補と同じfrozen install経路でbase依存を取得します。成功したstoreだけを保存対象とし、lifecycleは実行しません。失敗ならAI前に停止し、工程診断と `AI_API_not_called`、再開案内を表示します。原因・設定を修正してworkflowを再実行してください。事前確認成功は候補の取得成功・要求充足を保証しません。

候補では、入れ子も含むAI生成node_modules・store・その他のsnapshot対象外生成物を破棄し、保存storeの独立したファイルコピーへfrozen installします。候補のmanifest・lockfileに従い新規依存も取得します。`--ignore-pnpmfile` で取得中のJS hookを無効にし、manifest照合・store integrity・コピーによるimportを明示します。side-effects cacheを無効にします。追加runtime・任意URLの取得も固定registry宛先制限に従います。file / workspace / patch依存を扱うため、lockfileだけの `fetch → offline install` へ分割せず、pnpm標準installを継続採用します。hookが必須の候補はこの経路では未対応です。lifecycleはネットワーク・資格情報なしで実行し、storeも使い捨てのコピーだけを渡します。取得工程で照合したlockfileについてrebuild時の供給網metadata再照合を `offline=true / trust-lockfile=true` で抑止します。取得工程のfrozen照合・integrity検査は省略しません。候補store、node_modules、生成物をActions cacheへ保存しません。

`actions/cache` のrestore/saveを完全SHA `55cc8345863c7cc4c66a329aec7e433d2d1c52a9`（v6.1.0）に固定しました。公式README / release / MIT LICENSEとNode24・runner 2.327.1以上の要件を2026-10-24に確認しました。既定の `ubuntu-latest` を使い、新しいSecrets・write権限・有料サービスを要求しません。cacheサービス利用不能、miss、破損、削除時も隔離取得へ戻ります。restore/save失敗は検証成功の根拠にも失敗理由にもせず、Actionsの警告を確認します。保存可否は実行のcache権限・branch scopeに従い、read-only時は復元のみになる場合があります。

keyは専用namespace `latch-base-store-v1`、OS / architecture、Node / pnpm固定版、Node親imageのRepoDigest、信頼したDockerfile、固定base全tracked treeのdigestを含みます。全treeを含むのはworkspace・file依存・patch・各設定の取りこぼしを避けるためで、無関係なソース変更でもmissになります。完全一致だけを要求し、restore-keysとcross-OS archiveを使いません。pnpm v11 storeのprojectsリンク索引は共有せず、復元は常にファイルコピーして使用します。それ以外のsymlink / 特殊ファイル / 2 GiB超のstoreは破棄して再取得します。pnpmのintegrity照合を有効にして毎回installします。cacheをテスト証拠や安全性の保証として扱いません。保存元はAIにmountしない固定baseの取得結果だけです。

新規固定費はありませんが、LLM・Actions時間とcacheストレージは既存の従量費です。GitHub公式仕様では未アクセス7日で削除、既定上限10 GB、上限超過時のevictionがあります。容量拡張は課金され得るため、この変更では設定しません。cache ActionにはArtifactのような独自retention-daysを指定せず、GitHubの保持規則に従います。秘密情報をcacheに置かず、リポジトリのcache閲覧範囲を前提とします。

工程JSON / Summaryにはinstall時間、試行番号、cache状態（miss / copy / rejected / retry_empty）、pnpmのdownloaded / reused / added件数を保存します。取得できないカウンターはnullで、0へ補完しません。件数は取得バイト数や課金額ではありません。生ログやパッケージ名・URLは公開しません。cold / warmで同じ候補の検証を比較し、cache利用可否でテスト結果が変わらないことを確認します。実Actionsサービスでのhit / 保存 / eviction、実API費用、元の実行 #12のtimeout原因の確定は別の実環境確認です。

公式参照: [pnpm with](https://pnpm.io/cli/with)、[pnpm install](https://pnpm.io/cli/install)、[pnpm store](https://pnpm.io/cli/store)、[cache v6.1.0](https://github.com/actions/cache/tree/v6.1.0)、[GitHubの依存キャッシュ](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)。

#### ローカルの再現試験

`python3 -B .github/automation/dependency_smoke.py` を通常CIへ追加しました。2026-10-24の管理環境内Docker試験では、同じmanifest / lockfileと同じパッケージAPIのチェックで次を観測しました。時間はコンテナ起動を含む一回の値で、速度保証ではありません。

| 条件               | install時間 | downloaded | reused | 検証結果 |
| ------------------ | ----------: | ---------: | -----: | -------- |
| cold               |    4,982 ms |          1 |      0 | passed   |
| warm（独立コピー） |    4,644 ms |          0 |      1 | passed   |

この管理環境では外向き通信にセッションproxyが必要なため、ローカル試験だけ固定registry中継の上流へ接続するアダプターと公開CA mountを加えました。宛先制限・TLS検証・取得/lifecycle分離は維持し、アダプターは本番コードへ追加していません。固定base一式の事前取得も実コンテナで成功しました。取得timeoutとAPI前停止の分岐はPythonのDocker/APIモック試験で確認しており、実DeepSeek・実Actions cacheでの証拠ではありません。

同じ実コンテナ試験で、破損したstore索引からの再取得、変更manifest / 再生成lockfileによる新規依存追加、lockfile不整合の拒否、offline rebuildのpostinstall失敗分類も成功しました。`.pnpmfile.cjs` が実行されれば失敗するfixtureを使い、取得中のhook無効化を確認しています。

## 保存候補の検証だけを再実行する（#56）

通常の経路は `prepare → implement（AI・候補保存）→ validate/verify（依存準備・独立検証）→ validate/publish` です。`validate-candidate.yml` を通常実行と手動再開で共用します。呼出元はmainのworkflow、制御コード・Dockerfile・ポリシーは生成時の固定baseから取得します。候補内のworkflowを実行したり、最新mainへ自動的に載せ替えたりしません。verifyはcontents / actions readだけ、publishだけがcontents / pull-requests writeを持ちます。Secretsの包括継承はせず、検証経路にはDeepSeekキーを渡しません。

### Actionsでの操作

- **Re-run all jobs** はprepare・AI実装も実行するため、新しい候補とAPI費用が発生します。
- AI実装と候補uploadが成功し、validateだけが失敗した場合の **Re-run failed jobs**、または検証jobの再実行は、成功済みimplementの出力にある元attemptを使います。検証結果は新attemptのArtifactへ保存します。失敗jobの選択にimplementが含まれていればAIも再実行されるため、候補を確実に固定するには次の手動経路を使います。
- **Verify saved candidate → Run workflow** でmainを選び、元の **Issue to Draft PR** のrun IDと、候補を生成したattemptを指定します。検証runのIDや「現在の最大attempt」ではありません。例えば `gh workflow run verify-candidate.yml --ref main -f origin_run_id=123456 -f origin_attempt=1` です。これは手順例で、実run IDではありません。
- 手動再開は元候補を復元し、独立した依存準備と全必要チェックを最初から実行します。OpenCode・gatewayの起動、AI API呼出、APIキーは不要です。依存準備不能時の結果を成功へ読み替えません。
- 公開だけ失敗した場合はpublish jobを再実行できます。元の検証attemptとproposal Artifactを参照し、再検証・新コミットは行いません。候補が期限切れなら公開も停止します。

[GitHubのjob再実行](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) は同じ元SHA/refを使い、最初の実行者の権限で動くため、この処理では実行者に加え `GITHUB_TRIGGERING_ACTOR` の現在のwrite / maintain / admin権限も確認します。再利用workflowの再実行とArtifactの保持・削除は別です。

### 候補と結果の結合

`issue-candidate-<生成run ID>-<生成attempt>` は `candidate.json` 一つだけを含む、既定1日保持のv1 bundleです。要求スナップショット、Issue同一性、固定base / source、観測head、差分ファイル（削除・mode・binary・内部symlinkを含む）、実装状態、タイトル、生成run / attempt、作成・期限時刻を保存します。`candidate_digest` は差分と実装状態・タイトルの正規化JSONのSHA-256、`request_digest` は要求全体、`snapshot_digest` は復元後の提出ソース全体（生成物を除くパス・内容hash・mode）のSHA-256です。既存の工程診断の差分digestとは定義を区別します。

制御コード・Dockerfileのhashと生成時のagent image IDも保存します。検証時は元baseのツール定義を再ビルドし、実際の検証image IDを別途記録します。再ビルドのimage IDが同一になる保証はありません。依存の再取得を含め、同一のOS環境・外部registry状態まで再現する機能ではありません。

復元前にGitHub APIで対象リポジトリID / 名前、main由来のworkflow_dispatch、元workflowのパス、run / attempt、base SHA、現在の実行者・再実行者の権限を照合します。同一runの一意な名前のArtifactだけを選び、APIの期限・サイズ・SHA-256とダウンロードZIPを照合します。ZIPはサイズを制限し、固定名のJSONだけを読み、任意パスへ展開しません。保存manifest側の24時間期限も確認するため、コピーや再uploadで期限は延長できません。ArtifactやIssue文字列を任意コード実行の許可として扱いません。

復元した要求・差分を同じ安全検査へ通し、固定sourceのGit exportへ適用してsnapshot digestを照合します。不一致・秘密情報・パス異常・元ポリシーの不一致ならコンテナ起動前に停止します。検証コンテナ停止後にもソースhashを照合し、変更されていれば結果を公開しません。検証jobも元の固定baseのkeyでstoreを復元し、候補ごとの独立コピーでfrozen installを行います。検証jobから候補storeをcacheへ保存しません。cache miss・破損時は空のstoreから取得します。依存準備・各チェックの制限と隔離境界は従来どおりです。既定test内でbuildが成功したときは `build=not_run / covered_by_test` として重複実行を避けます。

結果はproposal schema v3で候補manifest、request / source / snapshot / policy digest、検証run / attempt、検証image IDと結合します。publishは元Artifactを再取得し、期限・内容・要求と結果の結合を再検査します。v3を従来v2として解釈しません。#56以前の実行には候補bundleがないため、新しい検証専用経路では再開できません。

### PR・失敗・保存費用

成功は「実行したチェックが成功」、失敗は各checkのfailed / timeout、依存環境不能はenvironment_unavailable、未実行はnot_runとして個別に表示します。AIの完了・不完了も独立した項目です。いずれも要件全体の充足を証明しません。検証用runnerの起動・image build・復元が失敗して結果を作れなかった場合は判定不能であり、成功した過去の結果を新しい検証結果として掲載しません。

PRには候補digest、snapshot digest、検証sourceと公開commit、生成run / attempt、検証run / attempt・ログURLを記載します。同じ候補の検証再試行ではcommit識別子をチェック結果から独立させ、同じbot commitのPR本文だけを更新します。PR API失敗後の回復、要求変更時のRefs、bot所有権、観測先端・人間コミット・閉じたPRの保護を維持します。先端が変わった場合は結果を新しい先端へ適用せず、Artifactを残して停止します。新しい候補の作成は別の通常実行です。

通常CIの起動は成功条件にしません。GITHUB_TOKENでDraft PRを作成する前に共通の独立検証jobへ到達し、後からも手動で同じ候補を検証できます。PAT追加、人間によるpush、自動マージは不要です。

候補・要求・proposalは1日、AI診断 `issue-diagnostics-*` と検証診断 `issue-validation-diagnostics-*` は14日保存します。保存済みチェック結果をキャッシュとして流用しません。候補欠落・削除・期限切れ・破損、元sourceの取得不能、権限喪失、非対応旧形式なら同一候補の再開不能として停止し、AIを自動的に起動しません。必要なら人間が費用を判断して通常実行を新たに開始します。

検証だけの再実行でもActions時間、Artifactの取得・保存、registry通信の費用条件は残ります。再ビルドと依存準備も毎回行います。LLM API費用を再消費しないことと無料であることは別です。[Actionsの料金](https://docs.github.com/en/billing/concepts/product-billing/github-actions) と現在のプラン枠を確認してください。キャンセル・runner強制終了・upload失敗では候補や診断を残せない場合があります。
