# サンプルAPIによる全工程の評価

Issue #27の未実施の実利用評価は #81へ引き継ぎます。**固定応答による接続の回帰テスト**と、**公式CLIによるモデル品質の手動評価**を分けます。旧BYOK方式での実API評価は取りやめます。固定応答の合格は、実モデルが要件や不足テストを正しく生成できる証拠にはしません。

## 再現可能な回帰テスト

Node.js 26とpackageManager指定のpnpmを使います。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec vitest run --project e2e tests/e2e/evaluation.test.ts
```

`tests/e2e/evaluation.test.ts` はビルド済みCLIの `plan` → `run --json` → `run` を実行します。計画JSONを手書きで渡す既存のrun試験とは異なり、入力解決・要件抽出・不足シナリオ・生成・隔離実行・両レポートの接続を確認します。PATH上の偽の `claude` 実行ファイルが固定応答を返し、外部LLMへ通信しません。公式CLI・アカウントは不要です。対象テストの通信は引き続き遮断します。

| ケース     | 入力                                           | 期待する条件状態            | 期待する証拠・終了コード                   |
| ---------- | ---------------------------------------------- | --------------------------- | ------------------------------------------ |
| correct    | correct.patch                                  | verified                    | 既存・生成テスト成功、0                    |
| buggy      | buggy.patch                                    | failed                      | 既存成功、生成assertion-failed、0          |
| ambiguous  | correct.patch＋Issue末尾に応答速度の曖昧な要求 | 割引verified、速度ambiguous | 曖昧な条件の証拠なし、要件全体ambiguous、0 |
| impossible | correct.patch＋終了しない固定生成テスト        | execution-impossible        | timeout、部分結果、2                       |

correctとbuggyは同一リポジトリの同一base・同一Issueを使用します。変更は未コミット差分として適用し、各ケース後に逆パッチで戻します。ambiguous以外は同じIssueです。各ケース1試行で、JSONとテキスト出力用にrunを各1回実行します。1ケース3要求、全体12要求がローカル固定応答CLIへ送られます。

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

## CLI固定応答の実測（2026-10-26 UTC）

実装commit `80e6ea79f21eeef151e46b7a30f7f776eae3b042` のビルド済みCLIで実行した [評価記録](evaluations/order-api-cli-fixed-2026-10-26.json) を保存しました。Node.js 26.12.0、各ケース1試行、計12回のローカル固定応答CLI起動です。correctはverified、buggyは既存テスト成功・生成テスト失敗、ambiguousは割引verified・速度ambiguous、impossibleはexecution-impossible・部分結果・終了コード2でした。全ケースでワークツリー不変を確認しました。実モデル要求0件、費用0 USD、token数は偽CLIが返さないため取得不能です。

これは採用版の実ログインや生成品質の実測ではありません。未改変CLIの未ログイン起動確認は [公式CLI接続](official-cli.md#検証と未実施の評価) に分離しています。

## 公式CLIによる実利用評価（未実施）

[公式CLIの対応条件](official-cli.md) を満たす環境と、利用者指定の契約・上限が決まってから実施します。現行コードはClaude Code接続であり、以下は未実施の実利用評価契約です。旧APIキーの設定手順と1 USD予算は廃止し、月額プランへ機械的に適用しません。固定応答の合格やヘルプの確認だけで実利用完了とはしません。

### 実行前に固定するもの

- 利用者が指定したCLI・契約・モデルと、要求数・時間・利用量の上限。公式条件に照らして利用可能範囲を確認し、一般の月額利用を可能と断定しない。
- 同一base・同一Issueから作るcorrect/buggyの候補。下の共通baseの手順で正解データと変更パッチを含まない候補を作り、全モデル要求が終わるまで評価側の正解データを開かない。
- 曖昧な要件を追加するケースと、生成テストが実行不能になるケース。期待状態は上の固定応答と同じ区別を維持する。
- コマンドごとの上限と全工程の上限。構造化出力・CLI内部の再試行・修復も含めて計上し、取得できない利用量や残上限を推定で補って継続しない。

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

## 現在の未達

公式CLIの採用・接続実装・CLI固定応答テストを実装しました。旧HTTPの [2026-10-25記録](evaluations/order-api-fixed-2026-10-25.json) は履歴として残します。現在のCLI固定応答回帰と、未改変バイナリの未ログイン起動確認は別です。実アカウントによる全工程・敵対的入力・生成品質・利用量の評価は未実施で、利用者の契約と上限の指定待ちです。#81で引き継ぎ、実利用未実施や条件未達のまま完了扱いにしません。
