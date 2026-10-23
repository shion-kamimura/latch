# 注文合計APIの入力を厳密に検証する

注文合計を計算する `POST /orders/total` は、入力の検証に抜けがある。既存テストは不正な入力を一部しか確認しておらず、境界値も未確認である。

## 受け入れ条件

- 各明細の `quantity` は1以上とする。上限 `MAX_UNITS_PER_LINE` ちょうどは許可し、上限を超える値・0・負数・小数は `invalid quantity`（ステータス400）として拒否する。
- 各明細の `sku` は英大文字・数字・ハイフンのみの3〜32文字とし、範囲外は `invalid sku`（ステータス400）として拒否する。
- `unitPriceCents` は0以上の整数とする。負数・小数は `invalid unit price`（ステータス400）として拒否する。
- `lines` が空の配列、または配列でない場合は `lines must be a non-empty array`（ステータス400）として拒否する。
- 既知でない `couponCode` は `unknown coupon`（ステータス400）として拒否する。
- `SAVE10`（10%）・`SAVE20`（20%）の割引額は円未満を切り捨てる。`subtotalCents` は割引前、`totalCents` は割引後、`appliedCoupon` は適用したクーポンまたは `null`。
- `POST /orders/total` 以外や不正なJSONは既存のまま拒否する。

## 入力の変更なしでの技術要件

- HTTP層のリクエスト・レスポンスは、実行時にテスト用オブジェクトを渡せるよう、必要なプロパティとメソッドだけを持つ構造的型で受け取る。
- `src/api.ts` は `node:http` の値や型へ依存しない。`src/server.ts` が実際のHTTPサーバーとの接続を担う。
