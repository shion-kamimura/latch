# サンプルAPIによる全工程の評価

Issue #27 の評価は、**固定応答による接続の回帰テスト**と、**実APIによるモデル品質の手動評価**を分けます。固定応答の合格は、実モデルが要件や不足テストを正しく生成できる証拠にはしません。

## 再現可能な回帰テスト

Node.js 26とpackageManager指定のpnpmを使います。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec vitest run --project e2e tests/e2e/evaluation.test.ts
```

`tests/e2e/evaluation.test.ts` はビルド済みCLIの `plan` → `run --json` → `run` を実行します。計画JSONを手書きで渡す既存のrun試験とは異なり、入力解決・要件抽出・不足シナリオ・生成・隔離実行・両レポートの接続を確認します。loopbackのHTTPサーバーが固定応答を返し、外部LLMへ通信しません。テスト実行プロセスにはloopback通信の許可が必要です。対象テストの通信は引き続き遮断します。

| ケース     | 入力                                           | 期待する条件状態            | 期待する証拠・終了コード                   |
| ---------- | ---------------------------------------------- | --------------------------- | ------------------------------------------ |
| correct    | correct.patch                                  | verified                    | 既存・生成テスト成功、0                    |
| buggy      | buggy.patch                                    | failed                      | 既存成功、生成assertion-failed、0          |
| ambiguous  | correct.patch＋Issue末尾に応答速度の曖昧な要求 | 割引verified、速度ambiguous | 曖昧な条件の証拠なし、要件全体ambiguous、0 |
| impossible | correct.patch＋終了しない固定生成テスト        | execution-impossible        | timeout、部分結果、2                       |

correctとbuggyは同一リポジトリの同一base・同一Issueを使用します。変更は未コミット差分として適用し、各ケース後に逆パッチで戻します。ambiguous以外は同じIssueです。各ケース1試行で、JSONとテキスト出力用にrunを各1回実行します。1ケース3要求、全体12要求がローカル固定応答サーバーへ送られます。

固定応答はIssueから独立に記述した割引端数のシナリオ1件だけを提案します。正解データ `fixtures/order-api/evaluation/cases.json` は全送信の終了後に評価側だけで読み、99にSAVE10を適用した期待値90と照合します。正解データを応答生成に使用しません。さらに追跡済み・変更済みの `evaluation/cases.json` にsentinelを置き、全要求の本文へ混入しないことを確認します。候補ファイル・未追跡ファイル・Git indexのハッシュ、HEADとstatusを前後比較します。

実行日時・Node版・モデル識別子・設定・base・Issue/diff/snapshotの識別子・状態と証拠ID・終了コード・要求数・時間を標準出力へ記録します。保存先を明示する場合は次のようにします。保存先は候補ワークツリーの外に置いてください。

```sh
LATCH_EVALUATION_RECORD=/tmp/order-api-regression.json \
  pnpm exec vitest run --project e2e tests/e2e/evaluation.test.ts
```

トークン利用量はモックが返さないため取得不能、実API要求数0・費用0 USDです。入力再現用にfixtureのSHA-256も記録します。一時リポジトリのcommitやsnapshot識別子は試行間で変わり得ます。

## 固定応答の実測（2026年10月25日 18:06 JST）

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

## 実APIの手動評価手順（未実施）

現在の実行環境にはBYOKキーがなく、実API評価は未検証です。以下は実施手順であり、実測結果ではありません。単一のOpenAI互換providerを選び、provider・endpoint・返却モデル識別子・実施日時・利用単価を記録してください。別providerへの自動切替はしません。

### 上限と設定

初回の上限は **1モデル・correct/buggy各1試行、合計4要求、1 USD、全体10分** とします。各コマンドの `limits.maxRequests=1`、`timeoutMs=30000`、`maxOutputTokens=4096`、生成修復 `maxRepairAttempts=0` とし、テキスト用の追加runは実施しません。CLIはトークン利用量・金額の集計や全コマンド共通の費用制限を持ちません。provider側で1 USD以内の上限を設定できる環境を用い、実行前に残予算を確認し、上限到達・認証失敗・時間超過・不正応答で中止します。送信済み分の課金は取り消せません。利用量が不明なら推定費用で継続せず停止し、取得不能理由を記録します。

候補ごとにワークツリー外へprofileを作成します。キーはprofileに含めず `LATCH_API_KEY` に設定します。profileの契約とデータ区分は [計画の仕様](requirement-planning.md)、隔離の制約は [実行の仕様](isolated-execution.md) を参照してください。

```json
{
  "version": 1,
  "id": "order-api-manual-evaluation",
  "decision": "allowed",
  "allowed": {
    "provider": "openai-compatible",
    "endpoint": "https://YOUR-PROVIDER/v1",
    "project": "/absolute/path/to/candidate",
    "dataCategories": ["issue", "diff", "tests"]
  },
  "connection": {
    "provider": "openai-compatible",
    "endpoint": "https://YOUR-PROVIDER/v1",
    "model": "YOUR-MODEL",
    "apiKeyEnv": "LATCH_API_KEY"
  },
  "limits": {
    "maxRequests": 1,
    "timeoutMs": 30000,
    "maxOutputTokens": 4096
  },
  "execution": {
    "dependencies": { "mode": "runner" },
    "network": { "allowedDestinations": [] },
    "limits": { "timeoutMs": 30000, "maxRepairAttempts": 0 }
  }
}
```

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

両候補の `git rev-parse origin/main` とIssueのSHA-256が同じことを確認します。profileの `allowed.project` を各候補の絶対パスに合わせ、profileは `$EVAL_ROOT` 直下など候補の外へ保存してください。候補では依存をインストールせず、Latchのrunner依存を使います。

各候補について実行前に全通常ファイルのSHA-256一覧、Git indexのSHA-256、HEAD、`git --no-optional-locks status --porcelain=v1 --untracked-files=all` を候補外へ保存します。終了後も同様に取得して比較し、変更があれば未達として記録します。

```sh
# correctで実行。buggyでも同じ手順を1回だけ行う。
cd "$EVAL_ROOT/correct"
node "$LATCH_ROOT/dist/cli.mjs" plan --base origin/main --issue-file issue.md \
  --profile "$EVAL_ROOT/correct-profile.json" --json > "$EVAL_ROOT/correct-plan.json"
# planが0で終了した場合のみ実行する。
node "$LATCH_ROOT/dist/cli.mjs" run --plan "$EVAL_ROOT/correct-plan.json" \
  --profile "$EVAL_ROOT/correct-profile.json" --json > "$EVAL_ROOT/correct-report.json"
```

開始・終了時刻と各終了コードを記録します。テキスト表示には保存したJSONの `renderRunText`（`src/run/render.ts`）をローカルで使えます。テキスト出力のCLI接続は固定応答テストで確認し、手動評価では追加runによる費用と生成の変動を避けます。

### 正解との照合と記録

全API要求が終わってから、評価側だけで `evaluation/cases.json` を開き、Issue条件ごとに計画・生成テスト・実行証拠を照合します。正解データをplanへ追記したり、生成処理へ送信したりしません。

- correctで実際に妥当なテストが失敗したら変更の不具合か正解データを再点検し、誤った生成アサーションなら誤検出として記録する。
- buggyの端数処理について生成テストの失敗・条件ID・証拠ID・期待90と実際89の差を確認する。既存テストだけの成功、未生成、誤った期待値のテスト成功は検出達成としない。見逃しか未検証として入力と再現手順を残す。
- 抽出されなかった要件、候補との誤対応、曖昧な条件の断定、生成不正、環境不足を区別する。runの終了コード0は全要件の合格を意味しない。
- 利用量はproviderの請求・利用量画面から取得する。CLIは応答のusageをレポートへ保持しないため、取得できなければ理由を記録する。キー・認証ヘッダー・環境変数全体・生の通信ログは保存しない。

評価記録には次を残します。

| 項目         | 記録内容                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 実行         | 日時、Latch commit、Node/pnpm版、OS、モデル指定名と返却識別情報（取得不能なら理由）、profileの秘密を含まない設定、試行数 |
| 再現入力     | fixture hashes、base/head、Issue/diff/snapshot/planのdigest、適用patch、追加要求                                         |
| ケース別結果 | 期待状態、実測状態、差異、誤検出・見逃し・未検証、条件/テスト/証拠ID、終了コード                                         |
| 利用         | 要求数（修復・再試行含む）、providerのtoken数・金額または取得不能理由、開始/終了と経過時間                               |
| 制約         | ワークツリー比較、送信対象、隔離方式、未検証領域、中止理由、次の課題                                                     |

## 残課題と後続Issue案

実API評価、複数回での変動率・抽出漏れ率・誤検出率の測定は未実施です。固定応答の端数1条件からAPI全体の品質を推定しません。HTTP接続・全境界条件・敵対的入力・OSレベル隔離はこの評価で確認していません。

次の独立したIssue候補を残します（本変更で登録・実装はしません）。

1. **LLM利用量と評価予算の集計**: plan・生成・修復を通した要求数、返却モデル、usageと取得不能理由を保存し、全工程の上限を設ける。現状のmaxRequestsは呼び出し単位で、全工程の費用上限ではない。
2. **実モデルの評価データを蓄積する**: 承認済み予算で同一入力を複数回評価し、抽出漏れ・誤検出・見逃し・生成不正とコストを条件別に比較する。

今回の実測は [固定応答の評価記録](evaluations/order-api-fixed-2026-10-25.json) に保存します。実API評価の未実施は #27 の実利用面の残項目です。
