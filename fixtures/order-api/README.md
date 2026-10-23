# 注文合計API評価fixture

Latchの評価用に、期待結果が明確で再現可能な小さなTypeScript / Node.js APIを用意します。外部サービス・DB・ネットワーク通信は使いません。Latch本体の検証機能・LLMはこのfixtureに含みません。

このfixtureは #22 の評価用入力・正解データ・差分です。`fixtures/ai-development/` は依存を持たない旧来の横断確認用で、このfixtureとは目的・構成が異なります。

## 構成

| パス                           | 役割                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- |
| `src/api.ts`                   | 注文合計の計算とHTTPルーティング。HTTP型は構造的型で受け取る               |
| `src/server.ts`                | `node:http` サーバーと `handleRequest` の接続                              |
| `src/cli.ts`                   | `PORT` 環境変数（既定は自動割り当て）で待ち受けるエントリーポイント        |
| `test/existing.test.ts`        | 対象リポジトリの既存テスト。正常系の一部と異常系のみを確認する             |
| `evaluation/cases.json`        | 正解データ（正常系・異常系・境界値・検出すべき不具合）                     |
| `evaluation/evaluate.test.ts`  | 評価専用テスト。正解データと照合する                                       |
| `issue.md`                     | Latchへ `--issue-file` で渡すIssue相当の要件                               |
| `changes/buggy.patch`          | 既存テストを通るが、評価専用テストで検出される不具合のある変更             |
| `changes/correct.patch`        | 要件を満たす正しい変更                                                     |
| `scripts/prepare-candidate.ts` | base・correct・buggyの候補と評価用コピーを作り、既存・評価専用テストを実行 |

### base（比較対象）と差分

baseはこのディレクトリの初期状態（`src/api.ts` などの現行ファイル）です。差分は `src/api.ts` だけを変更します。

- `base` → 変更なし。既存テストは通り、評価専用テストは `boundary.quantity-at-line-max` で失敗する。
- `changes/correct.patch` → `node:http` 型への依存を構造的型へ置き換え、数量の上限を「ちょうどまで許可」に修正する。既存・評価専用テストの両方が通る。
- `changes/buggy.patch` → `quantity > MAX_UNITS_PER_LINE` を `quantity >= MAX_UNITS_PER_LINE` に変え、上限ちょうどの妥当な注文まで拒否する。既存テストは通り、評価専用テストだけが失敗する。

## API仕様

`POST /orders/total` はJSON本文を受け取り、ステータスとJSON本文を返します。

| 条件                                             | ステータス | 本文                                           |
| ------------------------------------------------ | ---------- | ---------------------------------------------- |
| `lines` が1件以上の配列で、各項目が妥当          | 200        | `subtotalCents`, `totalCents`, `appliedCoupon` |
| `quantity` が1以上 `MAX_UNITS_PER_LINE`(10) 以下 | —          | `quantity` の上限ちょうどは許可する            |
| `quantity` が0・負数・小数・上限超え             | 400        | `{"error":"invalid quantity"}`                 |
| `sku` が `^[A-Z0-9-]{3,32}$` に一致しない        | 400        | `{"error":"invalid sku"}`                      |
| `unitPriceCents` が0以上でない                   | 400        | `{"error":"invalid unit price"}`               |
| `lines` が空配列・配列でない                     | 400        | `{"error":"lines must be a non-empty array"}`  |
| `couponCode` が `SAVE10` / `SAVE20` 以外         | 400        | `{"error":"unknown coupon"}`                   |
| JSONとして読めない本文                           | 400        | `{"error":"invalid JSON"}`                     |
| `/orders/total` 以外、または POST以外            | 404        | `{"error":"not found"}`                        |

割引額は `Math.round(subtotal * percent / 100)` で円単位に丸めます。`subtotalCents` は割引前、`totalCents` は割引後です。

## フレームワーク・配置の選定理由

- **Vitest** を選ぶ。リポジトリ本体がVitestを使っているためrunnerや設定の前提を揃えられ、`defineConfig` と `include` だけで既存テストと評価専用テストを分離できる。
- **フレームワーク不使用**。Express等ではルーティングが入力検証より先に隠れ、評価したい境界値処理が既存テストで薄くなる。`node:http` の薄い接続と構造的型の `handleRequest` にすれば、既存テストでHTTPサーバーを起動せずに検証でき、Latchが生成するテストの対象も明確になる。
- **評価専用テストの分離**。`test/**/*.test.ts` と `evaluation/**/*.test.ts`、設定ファイル2つ（`vitest.config.ts` / `vitest.evaluation.config.ts`）で分ける。候補コピーは `src`・`test`・設定のみを含み、`evaluation/` を含まない（正解データ・評価専用テストの漏えい防止）。
- **依存**。`vitest@5.0.5` のみを開発依存に固定し、`pnpm-lock.yaml` を同梱する。実行時に外部packageを取得しない。

## 依存の準備

`pnpm install --frozen-lockfile` はネットワーク禁止の環境で `pnpm` 自体がパッケージマネージャー依存を解決しようとして失敗する場合があります（この実行環境で確認）。そのため準備スクリプトは、リポジトリ本体で解決済みの `node_modules` を候補へ**リンクしないで参照**し、`evaluation/` を追加した別コピーで評価専用テストを実行します。

```sh
cd fixtures/order-api
node scripts/prepare-candidate.ts base      # 既存テスト: pass / 評価専用: fail を期待
node scripts/prepare-candidate.ts correct   # 両方 pass を期待（終了コード0）
node scripts/prepare-candidate.ts buggy     # 既存 pass / 評価専用 fail を期待
```

第2引数にパスを渡すと、作成した候補ディレクトリのパスをそのファイルへ書き出します（Latchへ渡す入力の取得用）。候補の `REPRO.md` に、`evaluation/` を含めないことと再実行手順を記録します。

`node_modules` がない環境では `pnpm install --frozen-lockfile`（npm registryの公開元のみ）でリポジトリ本体の依存を準備してください。

## 隔離環境での確認手順と未検証事項

候補は一時ディレクトリに作成し、テスト後に削除します。外部ネットワーク・DB・仮想マシンは使いません。コンテナ等での完全な隔離実行は未検証であり、Latch本体の隔離実行方式（#25）に依存します。この手順は依存の準備とテスト実行をホスト上で行うため、**Latchの隔離実行の代替ではありません**。

Latchで評価する場合は、候補ディレクトリをリポジトリ境界として扱い、`issue.md` と `changes/*.patch` の適用後差分を入力にします。正解データ `evaluation/` を探索対象・LLM入力へ含めない手順は上記の分離と準備スクリプトで担保します。
