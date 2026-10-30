# サンプルAPIによる全工程の評価

Issue #27の未実施の実利用評価は #81へ引き継ぎます。**固定応答による接続の回帰テスト**と、**公式CLIによるモデル品質の手動評価**を分けます。旧BYOK方式での実API評価は取りやめます。固定応答の合格は、実モデルが要件や不足テストを正しく生成できる証拠にはしません。

## 再現可能な回帰テスト

Node.js 26とpackageManager指定のpnpmを使います。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec vitest run --project e2e tests/e2e/evaluation.test.ts
```

`tests/e2e/evaluation.test.ts` はビルド済みCLIの `plan` → `run --json` → `run` を実行します。計画JSONを手書きで渡す既存のrun試験とは異なり、入力解決・要件抽出・不足シナリオ・生成・隔離実行・両レポートの接続を確認します。PATH上の偽の `codex` 実行ファイルが固定応答を返し、外部LLMへ通信しません。公式CLI・アカウントは不要です。対象テストの通信は引き続き遮断します。

| ケース     | 入力                                           | 期待する条件状態            | 期待する証拠・終了コード                   |
| ---------- | ---------------------------------------------- | --------------------------- | ------------------------------------------ |
| correct    | correct.patch                                  | verified                    | 既存・生成テスト成功、0                    |
| buggy      | buggy.patch                                    | failed                      | 既存成功、生成assertion-failed、0          |
| ambiguous  | correct.patch＋Issue末尾に応答速度の曖昧な要求 | 割引verified、速度ambiguous | 曖昧な条件の証拠なし、要件全体ambiguous、0 |
| impossible | correct.patch＋終了しない固定生成テスト        | execution-impossible        | timeout、部分結果、2                       |

correctとbuggyは同一リポジトリの同一base・同一Issueを使用します。変更は未コミット差分として適用し、各ケース後に逆パッチで戻します。ambiguous以外は同じIssueです。各ケース1試行で、JSONとテキスト出力用にrunを各1回実行します。1ケース3回、全体12回の推論用execをローカル固定応答CLIへ送ります。版・アカウント状態確認の起動は別です。

固定応答はIssueから独立に記述した割引端数のシナリオ1件だけを提案します。正解データ `fixtures/order-api/evaluation/cases.json` は全送信の終了後に評価側だけで読み、99にSAVE10を適用した期待値90と照合します。正解データを応答生成に使用しません。さらに追跡済み・変更済みの `evaluation/cases.json` にsentinelを置き、全要求の本文へ混入しないことを確認します。候補ファイル・未追跡ファイル・Git indexのハッシュ、HEADとstatusを前後比較します。

実行日時・Node版・モデル識別子・設定・base・Issue/diff/snapshotの識別子・状態と証拠ID・終了コード・要求数・時間を標準出力へ記録します。保存先を明示する場合は次のようにします。保存先は候補ワークツリーの外に置いてください。

```sh
LATCH_EVALUATION_RECORD=/tmp/order-api-regression.json \
  pnpm exec vitest run --project e2e tests/e2e/evaluation.test.ts
```

トークン利用量はモックが返さないため取得不能、実API要求数0・費用0 USDです。入力再現用にfixtureのSHA-256も記録します。一時リポジトリのcommitやsnapshot識別子は試行間で変わり得ます。

## 旧HTTP接続の固定応答実測（2026年10月25日 18:06 JST）

Node.js 26.12.1 / pnpm 12.14.0、Linuxで実行しました。基準のLatch commitは `4c5c326d37c949dc5c30c578b215cee147887bb1` で、このPRのindex更新抑止を適用した成果物です。各ケース1試行の記録であり、安定性の統計ではありません。

| ケース     | 実測                                           | 経過時間（plan＋JSON run＋text run） | 期待との差                    |
| ---------- | ---------------------------------------------- | ------------------------------------ | ----------------------------- |
| correct    | 既存5件成功、生成成功、条件verified            | 3,725 ms                             | なし。この1条件では誤検出なし |
| buggy      | 既存5件成功、生成assertion-failed、条件failed  | 3,408 ms                             | なし。端数不具合の見逃しなし  |
| ambiguous  | 割引verified、速度ambiguous、要件全体ambiguous | 3,431 ms                             | なし。速度を検証成功にしない  |
| impossible | 生成timeout、execution-impossible、終了2       | 4,111 ms                             | なし。製品不具合にしない      |

全ケースで候補ファイル・未追跡ファイル・index・HEAD・statusが不変、全12要求にsentinelの混入なし、隔離領域の削除成功を確認しました。実API要求0、0 USD、token数は固定応答が返さないため取得不能です。詳細な条件・証拠IDと入力識別子は [実測JSON](evaluations/order-api-fixed-2026-10-25.json) を参照してください。

評価中には、元の内容へ戻したファイルのmtimeが変わると `git diff` がindexのstat情報を更新する接続上の問題を発見しました。`GIT_OPTIONAL_LOCKS=0` だけでは防げなかったため、入力取得のGit操作に `diff.autoRefreshIndex=false` を指定しました。回帰テストはケース間でIssueを元の内容へ書き戻し、各plan/run後もindexのハッシュが変わらないことを検査します。

未抽出のIssue条件はこの固定応答では未検証です。HTTP全体の評価、実モデルの誤検出・見逃し・不安定さ・コストは未測定であり、実利用の受け入れ条件まで達成済みとは扱いません。

## 旧CLI固定応答の実測（2026-10-26 UTC）

当時のClaude接続の実装commit `80e6ea79f21eeef151e46b7a30f7f776eae3b042` のビルド済みCLIで実行した [評価記録](evaluations/order-api-cli-fixed-2026-10-26.json) を保存しました。Node.js 26.12.0、各ケース1試行、計12回のローカル固定応答CLI起動です。correctはverified、buggyは既存テスト成功・生成テスト失敗、ambiguousは割引verified・速度ambiguous、impossibleはexecution-impossible・部分結果・終了コード2でした。全ケースでワークツリー不変を確認しました。実モデル要求0件、費用0 USD、token数は偽CLIが返さないため取得不能です。

これは採用版の実ログインや生成品質の実測ではありません。未改変CLIの未ログイン起動確認は [公式CLI接続](official-cli.md#検証と実利用評価) に分離しています。

## Codex固定応答の実測（2026-10-26 UTC）

実装commit `b18be9de41723ac26349c8b47d4029b752aae3df` のビルド済みCLIで [Codex版の評価記録](evaluations/order-api-codex-fixed-2026-10-26.json) を保存しました。偽Codex 0.163.0の公開account/readとexecを通し、correct/buggy/ambiguous/impossible各1試行、推論用exec合計12回です。正しい変更はverified、既存テストを通るbuggyは生成テストの失敗でfailed、速度の曖昧な条件はambiguous、実行不能は部分結果・終了コード2となりました。全ケースでワークツリー・index・HEAD不変と正解データ非送信を確認しました。実モデル要求0件、費用0 USD、token数は偽CLIが返さないため取得不能です。これは実際のPlusアカウントのモデル品質・利用量の評価ではありません。

## 公式CLIによる実利用評価（未実施）

[公式CLIの対応条件](official-cli.md) を満たす実ログイン可能な環境を用意し、利用者指定の契約・利用範囲を記録してから実施します。現行コードはCodex CLI接続であり、以下は未実施の実利用評価契約です。旧APIキーの設定手順と1 USD予算は廃止し、月額プランへ機械的に適用しません。固定応答の合格やヘルプの確認だけで実利用完了とはしません。

### 実行前に固定するもの

- 利用者が指定したCLI・契約・モデルと、要求数・時間・利用量の任意上限の有無（上限なしならその選択）。公式条件に照らして利用可能範囲を確認し、一般の月額利用を可能と断定しない。
- 同一base・同一Issueから作るcorrect/buggyの候補。下の共通baseの手順で正解データと変更パッチを含まない候補を作り、全モデル要求が終わるまで評価側の正解データを開かない。
- 曖昧な要件を追加するケースと、生成テストが実行不能になるケース。期待状態は上の固定応答と同じ区別を維持する。
- コマンドごとと全工程で、上限の有無と指定値を記録する。構造化出力・CLI内部の再試行・修復も含めて計上し、取得できない利用量を推定値で埋めない。上限を指定した場合、その残量を確認できなければ継続しない。

### 同じbaseから候補を作る

Latchのcheckoutを `LATCH_ROOT` として、以下をローカル端末で実行します。独立した候補をコピーの許可リストから作り、正解データ・差分patch自体はコピーしません。

```sh
LATCH_ROOT=$(pwd)
EVAL_ROOT=$(mktemp -d)
mkdir "$EVAL_ROOT/base"
cp -R fixtures/order-api/src fixtures/order-api/test "$EVAL_ROOT/base/"
cp fixtures/order-api/package.json fixtures/order-api/tsconfig.json \
  fixtures/order-api/vitest.config.ts fixtures/order-api/issue.md "$EVAL_ROOT/base/"
git -C "$EVAL_ROOT/base" init -b main
git -C "$EVAL_ROOT/base" add .
git -C "$EVAL_ROOT/base" -c user.name=Evaluation -c user.email=evaluation@example.invalid \
  commit -m 'common evaluation base'
git clone "$EVAL_ROOT/base" "$EVAL_ROOT/correct"
git clone "$EVAL_ROOT/base" "$EVAL_ROOT/buggy"
git -C "$EVAL_ROOT/correct" apply "$LATCH_ROOT/fixtures/order-api/changes/correct.patch"
git -C "$EVAL_ROOT/buggy" apply "$LATCH_ROOT/fixtures/order-api/changes/buggy.patch"
```

両候補の `git rev-parse origin/main` とIssueのSHA-256が同じことを確認します。コマンド出力・評価記録は候補ワークツリーの外へ保存します。実行前後で全通常ファイルとGit indexのSHA-256、HEAD、`git --no-optional-locks status --porcelain=v1 --untracked-files=all` を比較し、不変性を確認します。公式CLI用のversion 2 profileとplan/runは [要件計画](requirement-planning.md#許可profile) を参照してください。

### 正解との照合と記録

全モデル要求が終わってから評価側だけで `evaluation/cases.json` を読み、Issue条件ごとに計画・生成テスト・実行証拠を照合します。

| ケース     | 必要な比較                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| correct    | 期待verifiedと実測を比較する。誤った生成アサーションの失敗は誤検出として記録する                                                     |
| buggy      | 既存テストの成功と生成テストの失敗、条件ID・証拠ID、期待90と実際89の差を確認する。未生成・誤った期待値・見逃しを検出達成扱いにしない |
| ambiguous  | 曖昧な要求を断定せず、ambiguous・証拠なしになるか比較する                                                                            |
| impossible | execution-impossible・部分結果・終了コード2と実測を比較する。生成不正や環境不足を製品不具合の証拠にしない                            |

評価記録には、日時、Latch commit、Node/pnpm・OS・CLI版、モデル指定名と返却識別情報、base/head・fixture hashes・Issue/diff/snapshot/planのdigest、試行数、条件/テスト/証拠ID、期待と実測の差、誤検出・見逃し・未検証、終了コード、経過時間、要求数、利用量、上限と中止理由を残します。モデル識別情報や利用量を取得できなければ理由を明記します。キー・ログイントークン・認証ヘッダー・環境変数全体・生の通信ログは保存しません。

テキスト表示のためだけに有料runを追加しません。固定応答でテキスト/JSONの接続を検証し、実利用では同じ実行結果から確認します。対象ワークツリー・未追跡ファイル・Git indexの不変、正解データ非送信、生成テストへの資格情報非継承も記録します。

## 旧評価と未達の履歴

公式CLIの採用・接続実装・CLI固定応答テストを実装しました。旧HTTPの [2026-10-25記録](evaluations/order-api-fixed-2026-10-25.json) は履歴として残します。現在のCLI固定応答回帰と、未改変バイナリの未ログイン起動確認は別です。実アカウントでcorrect候補のplan/run・レポート出力を確認しましたが、誤検出の改善・buggy比較・敵対的入力・利用量の評価が残っています。#81で引き継ぎ、実利用未実施や条件未達のまま完了扱いにしません。

2026-10-27、利用者の実ログインによるcorrect候補のplanは実行失敗しました（[記録](evaluations/codex-real-attempt-2026-10-27.json)）。旧例のgpt-5.4がChatGPTログインで提供終了していることを公式資料で確認し、例をgpt-6.1-solへ更新しました。生のCLI原因を取得していないため、この設定上の問題が唯一の原因とは断定しません。成功した実モデル評価には数えず、利用量・内部turn数は不明とします。

その後の利用者提供計画ではgpt-6.1-solのplanが成功し、8要件・15条件を抽出した。runは証拠IDの重複でレポート出力に失敗した（[実計画・run失敗の記録](evaluations/codex-real-plan-run-2026-10-27.json)）。各テストの成否や利用量は取得できておらず、成功と数えない。固定応答の回帰を複数生成条件・修復ありにも広げ、実機での修正後runを続ける。

修正後の [実correctレポートの評価](evaluations/codex-real-correct-run-2026-10-27.json) では、処理完了・16証拠IDの一意性を確認した一方、条件は検証成功4・失敗7・未検証1・要件不明確3でした。失敗7件は生成テストが想定したHTTP呼出し形式とサーバー生成方法の誤りで、correctの誤検出として扱います。runの推論起動は2回（うち修復1回）、利用量は不明です。処理完了を生成品質の合格へ読み替えず、追加モデル要求より先に入力契約の不足を改善します。

## ソース入力追加後の再評価

許可したsrc/api.ts・src/server.tsの全文を計画・生成・修復へ渡す機能を追加しました。[WSL実機再評価のコマンド](source-inputs.md#今回のwsl実機テストを再開する)で新しいprofile・plan・reportを作り、旧記録を保存して比較します。当初の停止履歴と、その後に完了したcorrect/buggy比較を下記へ分けて記録します。固定応答回帰によるHTTP呼出しとfactory初期化の成功を、実モデルの誤検出解消として記録しません。

2026-10-28（JST）確認の[利用者提供記録](evaluations/codex-real-source-inputs-2026-10-28.json)では、追加ソースを使ったcorrectは既存5件・生成53件成功、条件14件成功・3件不明確。buggyはplan成功後に生成/修復応答の契約検査で停止したため、不具合検出・見逃しは判定できません。旧エラーだけでは違反箇所や停止段階を特定できないため、段階・項目・固定理由の診断を追加しました。

## 完了した実correct/buggy比較と検証範囲

2026-10-28（JST）確認。同じbase・merge-base・Issue digestで、correctは既存5/生成53成功、buggyは既存5成功・生成33成功/2失敗。SAVE10の期待907/実際906、SAVE20の期待803/実際802は、割引の切り捨てを四捨五入へ変えたfixture不具合と一致しました。buggyの生成推論起動1回、修復なし、40証拠ID一意、後片付け成功です。終了0は処理完了で、条件は12成功・1失敗・1未検証・3不明確です。

[実利用記録](evaluations/codex-real-source-inputs-2026-10-28.json)へレポートの識別子・取得不能情報の理由と以前の停止試行も保存しました。検証範囲は、実correct/buggy比較、実レポートの曖昧な条件、固定応答の曖昧/実行不能、安全境界と不変性の自動テストを区別します。実モデルで実行不能・敵対的ケースを追加実行したとは扱いません。

この限定比較は、全要件の完全な品質保証ではありません。計画と生成の端数期待値の整合性、既存証拠だけの条件の扱いは後続の品質課題として残します。

固定応答による安全境界・失敗時の回帰は、[接続](../tests/unit/plan-llm.test.ts)、[profile](../tests/unit/plan-profile.test.ts)、[ソース入力](../tests/integration/source-inputs.test.ts)、[隔離実行](../tests/unit/run-execute.test.ts)、[全工程E2E](../tests/e2e/evaluation.test.ts) で確認します。実モデル実行前後の独立fingerprint、敵対的ツール実行、完全なOS隔離を実証したとは扱いません。各比較は1完了試行であり、同じ生成テストを両候補へ実行した比較でも、任意の不具合の検出率でもありません。
