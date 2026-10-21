# AIエージェント向け開発ルール

- Issueを設計する場合は [Issue設計ガイド](docs/issue-design.md) を参照する。
- GitHub Issueの目的・スコープ・受け入れ条件を確認し、遵守する。
- 原則としてIssue単位で作業ブランチを作成する（例: `feat/123-help`）。Issue番号がない作業でも専用ブランチを使用する。
- mainブランチへ直接コミットしない。変更はPull Requestでレビューを受ける。
- 動作変更を伴う場合は、適切なUnit・Integration・CLI E2Eテストを追加または更新する。
- 作業完了前に関連チェックを実行する。基盤変更時は `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm test`、`pnpm build` を実行する。
- `pnpm test` はUnit・Integrationの後にビルドし、ビルド済みCLIのE2Eを実行する。この順序を維持する。
- 検証できたこと、失敗したこと、未検証事項を明確に報告する。実行していないテストを成功したと報告しない。
- 大規模なアーキテクチャ変更は事前に人間の承認を得る。
- 依存関係の大幅な変更は事前確認する。
- シークレットやセキュリティ上重要な権限の変更は事前確認する。秘密情報をコミットしない。
- Issueと無関係な変更を最小限に抑える。
- Node.js 26とpnpmを使用し、依存関係を変更した場合は `pnpm-lock.yaml` も更新する。
