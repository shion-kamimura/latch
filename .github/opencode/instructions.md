# OpenCode GitHub連携固有の指示

共通ルールはAGENTS.md、準備・検証・PR前の文書更新・タイトルと本文の規則はdocs/development.mdを正本とし、作業に関係する節を参照する。

- 単独の `/oc`・`/opencode` は公式連携の要約依頼として扱う。
- branch・commit・push・通常PR作成は公式連携に任せる。新規PRは `draft=false`。Draft変換やReady操作は追加しない。
- workflowはdefault branchの依存だけを準備する。公式連携がPR headへ切り替えた場合、そのmanifest・lockfileで依存を準備し直してから検証する。
- 最終回答が新規PRの本文になる。`.github/pull_request_template.md` の6見出しを使う。公式連携が後から要求する短い要約も `<type>: <具体的な変更内容>` とし、文字数制限があってもtypeを保持する。
- セッション共有を有効化せず、生ログ・セッション・資格情報をartifactに保存しない。CIだけの失敗で有料AIを再起動せず、CIの再実行はGitHub標準機能を使う。
