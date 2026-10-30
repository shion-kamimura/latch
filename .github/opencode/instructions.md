# OpenCode GitHubでの実装

AGENTS.mdの作業別案内とdocs/development.mdを参照し、Issue・コメント・関連文書と受け入れ条件を読み、依頼範囲を実装する。質問・調査依頼ならその依頼に回答し、不要なコード変更を作らない。単独の `/oc`・`/opencode` は要約依頼として扱う。

- ブランチ・commit・push・通常PR作成は公式連携に任せる。新規PRは `draft=false` とし、Draft変換やReady for review操作を追加しない。
- PRへの修正依頼では同じPRのheadを使う。人の変更を保持し、force push・resetによる破壊を行わない。競合や権限不足は停止して報告する。マージ・レビュー承認・Secretsや実権限・課金設定の変更をしない。
- Node.js 26とpackageManager指定のpnpmを使う。公式連携がPR headへ切り替えた後は、そのmanifestとlockfileに対して `pnpm install --frozen-lockfile` を行う。依存変更時はlockfileを更新する。baseの依存準備だけでheadの依存が揃ったと扱わない。モデル・認証・依存準備の失敗を成功と書かない。
- 意味のあるテストを追加・更新し、影響するチェックを実行して修正する。基盤変更では `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm test` を実行する。test内のbuild成功を重複実行する必要はない。失敗・未実行・環境不足を区別する。
- PR作成前にdocs/development.mdに従って関連ドキュメントを更新し、コードと同じPRに含める。設計判断はADR、進捗・受け入れ確認・引き継ぎはIssue/PRへ記録する。Issue/PR単位の文書は作らない。更新不要ならPR本文に理由を書く。
- 最終回答が新規PRの本文になるため、`.github/pull_request_template.md` の6見出し「変更概要」「関連Issue」「実装内容」「実行したテスト」「テスト結果」「未検証事項」をすべて使う。ファイル一覧だけでなく変更後の動作、設計理由、各受け入れ条件への対応と残項目を書く。全条件を満たしたIssueだけ `Closes #番号`、親Issueの一部対応は `Refs #番号` で結ぶ。
- 実装中に自分で実行した自己テストと、PR作成・更新後に別workflowで走るCIを区別する。未実行のCIは「実行待ち／未確認」と書く。後から終わるCIは対象commitのChecks・Actionsログを正とし、CI終了ごとの本文同期は行わない。自己テスト合格やAIの説明を要件全体の検証済み判定にしない。
- 公式連携が最後に要求する短い要約も、PRタイトル・commit向けの `<type>: <具体的な変更内容>` とする。typeは feat / fix / docs / refactor / test / ci / choreから主目的に合わせる。番号だけの説明や汎用の「Fix issue」は使わない。40文字以内の要約を求められてもtypeを保持する。
- APIキー・認証ヘッダー・環境変数全体を表示しない。セッション共有を有効化せず、生ログ・セッション・資格情報をartifactへ保存しない。コストを節約し、CI失敗だけで新しいAI実行を起動しない。
