# 注文合計API評価fixture

Latchの評価用に、期待結果が明確で再現可能な小さなTypeScript / Node.js APIを用意します。外部サービス・DB・ネットワーク通信は使いません。Latch本体の検証機能・LLMはこのfixtureに含みません。

このfixtureは #22 の評価用入力・正解データ・差分です。

## 既存fixtureとの違い

- `fixtures/ai-development/` は依存不要のDuration APIを `node:test` で動かし、開発自動化の横断確認（パス制限・差分適用）に使います。
- `fixtures/order-api/` はTypeScript / Vitestの注文APIで、Issue入力・正解データ・既存/評価テストの分離・正しい/不具合差分を持ち、Latchの検証評価に使います。
- 目的が異なるため前者を置き換えず、併存させます。

## 構成

| パス                           | 役割                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- |
| `src/api.ts`                   | 注文合計の計算とHTTPルーティング。HTTP型は構造的型で受け取る               |
| `src/server.ts`                | `node:http` サーバーと `handleRequest` の接続                              |
| `src/cli.ts`                   | `PORT` 環境変数（既定は自動割り当て）で待ち受けるエントリーポイント        |
| `test/existing.test.ts`        | 対象リポジトリの既存テスト。正常系の一部と異常系の一部だけを確認する       |
| `evaluation/cases.json`        | 正解データ（正常系・異常系・境界値・検出すべき不具合）                     |
| `evaluation/evaluate.test.ts`  | 評価専用テスト。正解データと照合する                                       |
| `issue.md`                     | Latchへ `--issue-file` で渡すIssue相当の要件                               |
| `changes/buggy.patch`          | 既存テストを通るが、評価専用テストで検出される不具合のある変更             |
| `changes/correct.patch`        | 要件を満たす正しい変更                                                     |
| `scripts/prepare-candidate.ts` | base・correct・buggyの候補と評価用コピーを作り、既存・評価専用テストを実行 |

### base（比較対象）と差分

baseはこのディレクトリの初期状態（`src/api.ts` などの現行ファイル）です。差分は `src/api.ts` だけを変更します。

- `base` → 変更なし。既存テストは通るが、数量上限ちょうど（10）も拒否するため、評価専用テストは `boundary.quantity-at-line-max` で失敗する。
- `changes/correct.patch` → `quantity >= MAX_UNITS_PER_LINE` を `quantity > MAX_UNITS_PER_LINE` に直す。既存・評価専用テストの両方が通る。
- `changes/buggy.patch` → 数量の境界は直すが、割引額の計算を `Math.floor` から `Math.round` に変えてしまう。既存テストは通るが、評価専用テストは `boundary.fractional-cents` で失敗する。

baseと`buggy.patch`の不具合はいずれも既存テストでは検出できません。既存テストは数量11の拒否と、端数が出ない割引だけを確認しているためです。評価専用テストと正解データが不足を補います。

## API仕様

`POST /orders/total` はJSON本文を受け取り、ステータスとJSON本文を返します。

| 条件                                             | ステータス | 本文                                           |
| ------------------------------------------------ | ---------- | ---------------------------------------------- |
| `lines` が1件以上の配列で、各項目が妥当          | 200        | `subtotalCents`, `totalCents`, `appliedCoupon` |
| `quantity` が1以上 `MAX_UNITS_PER_LINE`(10) 以下 | —          | `quantity` の上限ちょうどは許可する            |
| `quantity` が0・負数・小数・上限超え             | 400        | `{"error":"invalid quantity"}`                 |
| `sku` が `^[A-Z0-9-]{3,32}$` に一致しない        | 400        | `{"error":"invalid sku"}`                      |
| `unitPriceCents` が0以上の整数でない             | 400        | `{"error":"invalid unit price"}`               |
| `lines` が空配列・配列でない                     | 400        | `{"error":"lines must be a non-empty array"}`  |
| `couponCode` が `SAVE10` / `SAVE20` 以外         | 400        | `{"error":"unknown coupon"}`                   |
| JSONとして読めない本文                           | 400        | `{"error":"invalid JSON"}`                     |
| `/orders/total` 以外、または POST以外            | 404        | `{"error":"not found"}`                        |

割引額は `Math.floor(subtotalCents * percent / 100)` で円未満を切り捨てます。`subtotalCents` は割引前、`totalCents` は割引後です。

## サーバーの起動

Node.js 26の型ストリッピングで直接起動できます。

```sh
cd fixtures/order-api
PORT=0 node src/cli.ts
```

表示されたURLへ `POST /orders/total` を送ります。baseのままでは `quantity` が上限ちょうど（10）の注文も400になるため、不具合を手元で確認できます。`changes/correct.patch` を適用すると200になります。

## フレームワーク・配置の選定理由

- **Vitest** を選ぶ。リポジトリ本体がVitestを使っているためrunnerや設定の前提を揃えられ、`defineConfig` と `include` だけで既存テストと評価専用テストを分離できる。
- **フレームワーク不使用**。Express等ではルーティングが入力検証より先に隠れ、評価したい境界値処理が既存テストで薄くなる。`node:http` の薄い接続と構造的型の `handleRequest` にすれば、既存テストでHTTPサーバーを起動せずに検証でき、Latchが生成するテストの対象も明確になる。
- **`src/api.ts` は `node:http` の値や型に依存しない**。`src/server.ts` だけが実HTTPサーバーへ接続する。テスト用のリクエスト・レスポンスは `RequestLike` / `ResponseLike` の構造的型で渡す。
- **importは `.ts` 拡張子を使う**。Node.js 26の型ストリッピングでサーバーを直接起動できるようにし、`tsconfig.json` で `allowImportingTsExtensions` を有効にする。Vitestもこの指定を解決できる。
- **評価専用テストの分離**。`test/**/*.test.ts` と `evaluation/**/*.test.ts`、設定ファイル2つ（`vitest.config.ts` / `vitest.evaluation.config.ts`）で分ける。候補コピーは `package.json`・`tsconfig.json`・`src`・`test`・`vitest.config.ts` のみを含み、`evaluation/` と `vitest.evaluation.config.ts` を含まない（正解データ・評価専用テストの漏えい防止）。
- **依存**。`vitest@5.0.5` のみを開発依存に固定し、`pnpm-lock.yaml` を同梱する。実行時に外部packageを取得しない。

## 依存の準備

fixtureは独立したlockfileを持ちます。ネットワークが使える環境ではfixture側で依存を準備できます。

```sh
cd fixtures/order-api
pnpm install --frozen-lockfile
```

このリポジトリの開発環境では、一時コピーで上記のinstallと既存テスト5件の実行を確認済みです。CIやネットワーク制限のある環境では、リポジトリ本体で解決済みの `node_modules` を候補へ**リンクしないで参照**します。準備スクリプトはvitestの実体をリポジトリ本体の `node_modules` から解決し、候補ディレクトリへシンボリックリンクします。これによりfixture側の依存取得ができなくても、テスト実行そのものは確認できます。

```sh
cd fixtures/order-api
node scripts/prepare-candidate.ts base      # 既存テスト: pass / 評価専用: fail を期待
node scripts/prepare-candidate.ts correct   # 両方 pass を期待（終了コード0）
node scripts/prepare-candidate.ts buggy     # 既存 pass / 評価専用 fail を期待
```

第2引数にパスを渡すと、作成した候補ディレクトリのパスをそのファイルへ書き出します（Latchへ渡す入力の取得用）。候補の `REPRO.md` に、`evaluation/` を含めないことと再実行手順を記録します。

評価専用テストは、候補をさらに一時領域へコピーして `evaluation/` と `vitest.evaluation.config.ts` を追加した別ディレクトリで実行します。元の候補には正解データを追加しません。

## 隔離環境での確認手順と未検証事項

候補は一時ディレクトリに作成し、テスト後に削除します。外部ネットワーク・DB・仮想マシンは使いません。Latch本体の #25 では、固定入力の一時コピーとNode.jsパーミッションモデルによる隔離実行・通信遮断・証拠収集を実装しました（[隔離実行の仕様](../../docs/isolated-execution.md)）。コンテナ等のOSレベル分離は未検証です。この準備スクリプトは依存の準備とテスト実行をホスト上で行うため、**Latchの隔離実行の代替ではありません**。

Latchで評価する場合は、候補ディレクトリをリポジトリ境界として扱い、`issue.md` と `changes/*.patch` の適用後差分を入力にします。正解データ `evaluation/` を探索対象・LLM入力へ含めない手順は上記の分離と準備スクリプトで担保します。ただし、実LLMへの送信内容をこのfixture単体で検査したわけではありません。

リポジトリ本体のVitestから候補の既存テストだけを実行する場合は、`LATCH_FIXTURE_ROOT` に候補ディレクトリを指定します。

```sh
LATCH_FIXTURE_ROOT=/path/to/candidate pnpm exec vitest run --project fixture
```
