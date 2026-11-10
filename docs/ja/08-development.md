# 8. 開発者向け

[English](../en/08-development.md) | 日本語 ｜ [手順書の目次](../README.md)

コードの構成、テスト、CI、リリースの手順です。変更を提案する方法は [CONTRIBUTING.ja.md](../../CONTRIBUTING.ja.md) を参照してください。

## 8.1 リポジトリの構成

```
.
├── config/datasets.yaml        # データセットの定義（利用者が書く）
├── cdk/                        # pnpm workspace のパッケージ（CDK アプリと Lambda）
│   ├── bin/                    # CDK アプリの入口（設定とデプロイオプションの検証）
│   ├── lib/                    # スタックと部品、設定のスキーマ（zod）
│   ├── lambda/api/             # Lambda（API）
│   ├── lambda/ingest/          # Lambda（コールドストアへの取り込み）
│   └── test/                   # unit / cdk / integration
├── scripts/                    # pnpm workspace のパッケージ（seed、init-dataset、check など）
│   ├── lib/                    # 推定・生成などの純粋関数
│   └── test/
├── grafana/                    # docker-compose、provisioning、サンプルダッシュボード
├── docs/                       # 手順書（ja / en）
└── .github/                    # CI、Dependabot、Issue / PR のテンプレート
```

## 8.2 Lambda（cdk/lambda/api）

| ファイル | 役割 |
|---|---|
| `index.ts` | Lambda の入口。REST API（ペイロード 1.0）と関数 URL（2.0）の両方を受ける |
| `app.ts` | `createApi()`。パスの振り分け、キャッシュ、構造化ログ。依存（設定、DynamoDB クライアント、キャッシュ、ログ、時計）を受け取る |
| `request.ts` | `/query` のパラメータの検証 |
| `key-condition.ts` | パーティションキーの値、ソートキーの範囲、時刻の読み取り |
| `reader.ts` | Query API のページング、並列実行、上限による打ち切り |
| `transform.ts` | 列の選択、ProjectionExpression、型の変換 |
| `aggregate.ts` | 集計と出力形式（long / wide） |
| `response.ts` | 応答の組み立てとサイズの確認 |
| `catalog.ts` | `/datasets` と `/keys` |
| `cache.ts` | 応答キャッシュ（TTL、バイト数の上限） |
| `time.ts` | タイムゾーンの計算（外部ライブラリなし） |
| `types.ts` / `errors.ts` / `rows.ts` | 共有の型、エラー、行の並び順 |
| `split.ts` | 範囲をホットとコールドに分ける（境界 = 現在 − hotRetention） |
| `cold/sql.ts` / `cold/athena.ts` / `cold/reader.ts` | コールドストアの列と SQL、Athena の実行（タイムアウトで停止）、結果を途中集計に変換 |

`aggregate.ts` は、件数・合計・最小・最大・最後の値の途中集計を足し合わせてから agg の値にします。DynamoDB の行とコールドの集計済みの行を同じ区切りでまとめられるのはこのためです。

### コールドストアへの取り込み（cdk/lambda/ingest）

| ファイル | 役割 |
|---|---|
| `rollup.ts` | 行 → 1 分の集計、Parquet への書き出し（hyparquet-writer） |
| `day.ts` | 1 日分（UTC）の取り込み（Query → 集計 → S3、日付のフォルダを置き換える）。`pnpm cold-backfill` と `pnpm seed --cold-days` も使う |
| `scheduled.ts` | 定期実行の Lambda の入口 |
| `stream-match.ts` / `stream.ts` | ストリームのアイテムをデータセット・キーに振り分ける処理と、ストリームの Lambda の入口 |

設計の方針:

- DynamoDB は Query API だけを使います（Scan はしない）。柔軟さは `datasets.yaml` で出します
- 設定は synth のときに検証し、`datasets.generated.json` として Lambda に同梱します（環境変数は 4KB の上限があるため使いません）
- DynamoDB クライアントは `QueryClient` インターフェイスで受け、テストでは偽物に差し替えます
- API の外部ライブラリは AWS SDK だけです。AWS SDK はバンドルに含めず、Lambda ランタイム同梱のものを使います（取り込みの Lambda だけ、Parquet を書くために hyparquet-writer を同梱します）

## 8.3 CDK（cdk/lib）

| ファイル | 役割 |
|---|---|
| `config.ts` | `datasets.yaml` のスキーマ（zod）、既定値の反映、エラーの表示 |
| `options.ts` | デプロイオプション（`-c`）の検証 |
| `dynamodb-timeseries-api-stack.ts` | スタック |
| `api-function.ts` / `endpoint.ts` / `grafana-access.ts` / `sample-table.ts` | Lambda、公開形態ごとの入口、Grafana 用 IAM、サンプルテーブル |
| `cold-store.ts` / `cold-ingest.ts` / `cold-stream.ts` | コールドストア（S3、Glue、Athena、API の権限）、定期実行の取り込み、ストリームの取り込み（Firehose） |

各部品は、子のコンストラクトにせず、スタックを scope として直接リソースを作ります。論理 ID を変えないためです（変えると、既存の環境でロググループや API が作り直されます）。リソースの構成を変える変更は、CHANGELOG に置き換えの有無を書いてください。

## 8.4 開発の準備

```bash
pnpm install
pnpm lint          # Biome（lint と format の確認）
pnpm format        # Biome で整形
pnpm typecheck     # TypeScript（cdk と scripts）
```

## 8.5 テスト

| コマンド | 内容 | 必要なもの |
|---|---|---|
| `pnpm test` | ユニットテスト（cdk と scripts）と CDK のテンプレートのテスト | なし |
| `pnpm test:integration` | DynamoDB Local を使う結合テスト | DynamoDB Local |
| `pnpm coverage` | カバレッジ（cdk の unit + integration） | DynamoDB Local |

```bash
docker run -d --rm -p 8000:8000 amazon/dynamodb-local:3.3.2 -jar DynamoDBLocal.jar -inMemory
pnpm test:integration
```

| 場所 | 内容 |
|---|---|
| `cdk/test/unit` | Lambda と設定の検証。DynamoDB は偽のクライアント（`fakeClient`） |
| `cdk/test/cdk` | `aws-cdk-lib/assertions` でテンプレートを検証（公開形態・認証の組み合わせ、IAM の権限の範囲） |
| `cdk/test/integration` | DynamoDB Local にテーブルを作り（`global-setup.ts`）、`createApi()` を通して確かめる |
| `scripts/test` | 推定、データソース設定の生成、署名付きの呼び出し、サンプルデータの生成 |

テストの方針:

- 新しい設定項目やパラメータには、ユニットテストを付けます。DynamoDB の動きに依存する場合は結合テストも付けます
- CDK のテストは、synth のたびに書き換わる `datasets.generated.json` を前後で保存・復元します
- 結合テストの DynamoDB Local の接続先は `AWS_ENDPOINT_URL_DYNAMODB`（既定 `http://localhost:8000`）です

## 8.6 ローカルで API を動かす

```bash
docker compose -f grafana/docker-compose.yml --profile local up -d
export AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000 AWS_REGION=ap-northeast-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local
pnpm seed --create
pnpm local-api                                   # http://localhost:13000/
pnpm check --endpoint http://localhost:13000
```

`pnpm local-api` は Lambda と同じ `createApi()` を、認証なしの HTTP サーバーで動かします。

## 8.7 CI

`.github/workflows/ci.yml` が、push（main）と PR で次を実行します。

| ジョブ | 内容 |
|---|---|
| check（Node.js 22 / 24） | `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm cdk-synth`（AWS の認証情報なし） |
| integration | DynamoDB Local（services）で `pnpm test:integration` |

Dependabot が、npm の依存（AWS SDK、AWS CDK、開発ツールをまとめて）、GitHub Actions、docker-compose のイメージの更新を週 1 回提案します。

## 8.8 リリース

1. `CHANGELOG.md` の Unreleased を、バージョンと日付の見出しに変えます
2. ルートと各パッケージの `package.json` の `version` を上げます（[セマンティック バージョニング](https://semver.org/lang/ja/)。設定ファイルの互換性がなくなる変更はメジャー）
3. main に取り込み、`v0.2.0` のようなタグを付けて GitHub のリリースを作ります

## 8.9 AWS で確かめる

変更が AWS の挙動に関わる場合（IAM、公開形態、ログなど）は、自分のアカウントにデプロイして確かめます。

```bash
pnpm cdk-deploy -c sample=true -c grafanaUser=true
pnpm seed && pnpm check
# 確かめたら片付ける（アクセスキーを先に削除）
pnpm cdk-destroy -c sample=true -c grafanaUser=true
```

IAM の変更の反映には数分かかることがあります。同じプリンシパルの権限を切り替えて試すと結果が揺れるので、権限の組み合わせを比べるときは、組み合わせごとに別の IAM ユーザーを使ってください。

## 8.10 手順書の画像

画像は `docs/images/` にあります。

| 種類 | ファイル | 更新のしかた |
|---|---|---|
| 構成図 | `architecture` / `exposure` / `auth` / `hot-cold`（`.drawio` と `.png`） | draw.io で `.drawio` を開いて直し、PNG に書き出す（`drawio -x -f png -s 2 -b 16 -o <名前>.png <名前>.drawio`） |
| Grafana の画面 | `<名前>-light.png` / `<名前>-dark.png` | `pnpm docs-screenshots`（下記） |
| 流れ図 | 手順書の中の Mermaid | Markdown を直接直す（GitHub が描画する） |
| ソーシャルプレビュー | `social-preview.png`（1280×640） | GitHub のリポジトリの Settings → Social preview でアップロードする |

Grafana の画面は、ライトとダークの両方を撮り、`<picture>` で閲覧者のテーマに合わせて切り替えて表示します。

```bash
pnpm --dir scripts exec playwright install chromium   # 初回だけ
pnpm grafana-config && pnpm grafana-up                # データの入った Grafana を起動しておく
pnpm docs-screenshots                                 # docs/images/<名前>-light.png / -dark.png を上書き
pnpm docs-screenshots --cold                          # コールドストアの画面も撮る（cold=true と pnpm seed --cold-days 30 が必要）
pnpm docs-screenshots --only dashboard,meta           # 一部だけ撮り直す
```

画面の構成（URL、画面の高さ、撮る前の操作）は `scripts/docs-screenshots.ts` の `shots` にあります。Grafana の版が変わって画面の要素が変わったときは、ここを直します。
