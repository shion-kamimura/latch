# ソースの呼び出し方をAIへ渡す

状態: 実装済み。固定応答による回帰は実モデルの生成品質の保証ではありません。変更後のPlus実機評価は未実施です。

差分だけでは、変更されていない型や初期化関数がAIに見えないことがあります。注文APIの実機評価では、非同期イテレーターで本文を読むリクエストをイベント形式で模擬し、サーバーを作る関数を呼ばずにimportだけで初期化されると仮定したため、正しいコードを失敗と判定しました。

`allowed.sourceFiles` は、そのような呼び出し方を確認するため、選んだファイルの全文をモデルへ送る設定です。型だけを抽出する機能ではありません。期待する結果はIssueと計画済みの要件から決め、実装の計算結果をコピーして合格させるためには使いません。

## 許可の書き方

ワークツリー外の利用者管理profileで、`allowed.dataCategories` に `source` を追加し、`allowed.sourceFiles` にリポジトリルートからの相対パスを個別指定します。

```json
{
  "allowed": {
    "provider": "codex-cli",
    "project": "/home/YOUR_USER/code/my-app",
    "dataCategories": ["issue", "diff", "tests", "source"],
    "sourceFiles": ["src/api.ts", "src/server.ts"]
  }
}
```

これはprofileの抜粋です。既存のversion・id・decision・connection等を残してください。source区分だけではファイルを選びません。指定なし・空配列では追加のソース全文を送りません。従来のIssue・差分・テスト候補に含まれるコードは従来どおりです。

JS/TSの通常ファイルだけを受け付けます。ディレクトリ・glob・境界外・symlink・既知の認証パス・評価用正解データ・生成物は拒否します。未追跡ファイルはplanの `--include-untracked` にも指定してください。import先を再帰的に読んだり、コードの文章を送信許可にしたりはしません。ソースへ埋め込まれた秘密を検出する機能はないため、送る全文を事前に確認してください。

選択した内容は計画・生成・修復へ渡されます。利用者が入力文字数の上限を指定した場合、planでは切り詰めと警告が発生し、生成・修復では上限超過時に停止します。モデルのファイル操作やネットワーク、シェル等の権限は増えません。実行量の上限は追加していません。

## 計画を作り直す理由

planには追加ソースのパスとSHA-256を保存し、planのdigestにも含めます。全文はplanへ保存しません。runは現在のprofileと内容を照合し、選択・許可・内容が変わっていたらモデル要求前に停止します。runのレポートにもパスとSHA-256が残ります。従来のsnapshotDigestはIssue・差分の識別子のままで、追加ソースは別の識別情報です。

ソースを追加する場合、古い計画をそのまま再実行せずplanから作り直してください。生成中に修復が必要になっても、最初に固定した同じソース入力を使います。

## 今回のWSL実機テストを再開する

以下は、既存のcorrect用profileを残して、2ファイルの全文送信を許可した新しいprofileを作る手順です。Ubuntu自体の更新はこの変更に必要ありません。

```sh
export LATCH_ROOT="$HOME/code/latch-real-test"
export EVAL_ROOT="$HOME/.local/share/latch/eval-81.VNQS6s"
export CODEX_HOME="$HOME/.local/share/latch/codex"

(
  set -e
  cd "$LATCH_ROOT"
  git pull --ff-only
  pnpm build

  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.EVAL_ROOT;
const profile = JSON.parse(readFileSync(join(root, 'correct-profile.json'), 'utf8'));
profile.allowed.dataCategories = [...new Set([...profile.allowed.dataCategories, 'source'])];
profile.allowed.sourceFiles = ['src/api.ts', 'src/server.ts'];
writeFileSync(join(root, 'correct-profile-with-source.json'), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
NODE

  cd "$EVAL_ROOT/correct"
  node "$LATCH_ROOT/dist/cli.mjs" plan \
    --base origin/main --issue-file issue.md \
    --profile "$EVAL_ROOT/correct-profile-with-source.json" \
    --json > "$EVAL_ROOT/correct-plan-with-source.json"
)
```

planの要件と不明確な条件を確認してからrunします。planもrunも実モデルを利用します。利用者が指定した任意上限がなければLatch側で実行量を打ち切りません。契約側の利用上限は適用されます。

```sh
(
  cd "$EVAL_ROOT/correct" || exit 1
  result=0
  node "$LATCH_ROOT/dist/cli.mjs" run \
    --plan "$EVAL_ROOT/correct-plan-with-source.json" \
    --profile "$EVAL_ROOT/correct-profile-with-source.json" \
    --json > "$EVAL_ROOT/correct-report-with-source.json" || result=$?
  printf '終了コード: %s\n' "$result"
  printf 'レポート: %s\n' "$EVAL_ROOT/correct-report-with-source.json"
)
```

旧plan/reportは比較用に残ります。終了コード0だけで合格とせず、以前の7条件の誤検出が解消されたか、別の誤りへ置き換わっていないか、未検証・要件不明確の条件を確認します。その後にbuggy候補でも独立したprofile・planを作り、不具合の見逃しを比較します。correctの結果が出るまでは改善済みとは記録しません。
