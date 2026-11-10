# コントリビュート

[English](CONTRIBUTING.md) | 日本語

このプロジェクトに関心を持っていただき、ありがとうございます。Issue と Pull Request は、日本語でも英語でも歓迎します。

## Issue の報告

- 不具合: 不具合の報告のテンプレートを使ってください。`datasets.yaml` の該当部分、`pnpm check` の出力、または CloudWatch Logs の 1 行（`type = query`）を添えてください。秘密情報と AWS アカウント ID は除いてください
- 機能の提案: テーブル設計と、Grafana で表示したいものを書いてください。読めるテーブル設計を増やす設定は特に歓迎します
- 脆弱性: 公開の Issue にはしないでください。[SECURITY.md](SECURITY.md) を参照してください

## 開発の準備

```bash
pnpm install
pnpm lint            # Biome
pnpm typecheck       # TypeScript
pnpm test            # ユニットテストと CDK のテンプレートのテスト（AWS も Docker も不要）

docker run -d --rm -p 8000:8000 amazon/dynamodb-local:3.3.2 -jar DynamoDBLocal.jar -inMemory
pnpm test:integration
```

必要なもの: Node.js 22 以上、pnpm 10 以上、Docker。npm / npx ではなく pnpm を使います。

コードの構成とテストの配置は [開発者向け](docs/ja/08-development.md) を参照してください。

## Pull Request

1. `main` からブランチを作ります
2. テストと一緒に変更します
   - 新しい設定項目やパラメータには、ユニットテストを付けます。DynamoDB の動きに依存する場合は結合テストも付けます
   - CDK の変更には、`cdk/test/cdk` のテンプレートのテストを付けます
3. `pnpm format`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:integration` を実行します
4. 利用者に見える変更は、手順書を両方の言語で更新します（`docs/en` と `docs/ja`、`README.md` と `README.ja.md`）
5. `CHANGELOG.md` の「Unreleased」に追記します
6. Pull Request を作り、テンプレートに沿って書きます

## 方針

- API は読み取り専用で、Query だけを使います。Scan や書き込みは加えません
- IAM の権限は最小にします。新しい権限を加える場合は、理由を Pull Request に書いてください
- 既存のリソースの CloudFormation の論理 ID は変えません（既存の環境でリソースが置き換わるため）。やむを得ない場合は CHANGELOG に書いてください
- エラーメッセージは、何が誤りで、どう直せばよいかがわかるように書きます
- 利用者に見えるメッセージ（API のエラー、設定の検証、CLI の出力）は英語で書きます
- コード、テスト、手順書、スクリーンショットに、秘密情報、アクセスキー、アカウント ID を含めません

## ライセンス

コントリビュートした内容は [MIT License](LICENSE) で提供されることに同意したものとします。
