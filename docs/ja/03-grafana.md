# 3. Grafana との接続

[English](../en/03-grafana.md) | 日本語 ｜ [手順書の目次](../README.md)

Grafana からは、Infinity データソース（yesoreyeram-infinity-datasource）で API を呼びます。Grafana の環境ごとに、使える認証方式が違います。

| 環境 | 認証方式 | 状態 |
|---|---|---|
| セルフホスト（ローカルの Docker） | IAM（アクセスキー） | 確認済み |
| セルフホスト（EC2 など） | IAM（EC2 のロールで AWS SDK Default） | ドキュメントによる |
| Grafana Cloud | IAM（アクセスキー）または API キー | 未検証（Infinity のドキュメントによる） |
| Amazon Managed Grafana | IAM（アクセスキー） | 未検証 |

確認した組み合わせ: Grafana OSS 13.3.1、Infinity 4.1.5（2026/11）。

## 3.1 Infinity を入れる

| 環境 | 入れ方 |
|---|---|
| ローカルの Docker（このリポジトリ） | `grafana/docker-compose.yml` が起動時に入れる（`GF_PLUGINS_PREINSTALL_SYNC=yesoreyeram-infinity-datasource@4.1.5`） |
| セルフホスト | 「Administration」→「Plugins and data」→「Plugins」で Infinity を検索して入れる。または `grafana cli plugins install yesoreyeram-infinity-datasource` |
| Grafana Cloud | 「Connections」→「Add new connection」で Infinity を検索して入れる |
| Amazon Managed Grafana | ワークスペースのプラグイン管理（プラグインカタログ）から入れる |

## 3.2 データソースを設定する

### (1) provisioning で設定する（セルフホスト向け）

```bash
pnpm grafana-config      # デプロイの出力から作る
```

`grafana/provisioning/generated/datasources/dynamodb-timeseries-api.yaml` ができます。セルフホストの Grafana なら、このファイルを Grafana の `provisioning/datasources/` に置き、アクセスキーを環境変数（`TSAPI_AWS_ACCESS_KEY_ID` / `TSAPI_AWS_SECRET_ACCESS_KEY`、API キー認証なら `TSAPI_API_KEY`）で渡して Grafana を起動します。

サンプルダッシュボードとアラートルールは、データソースの UID `tsapi` を参照します。画面で作る場合も、UID を `tsapi` にするとサンプルをそのまま使えます（画面では UID を指定できないため、画面で作った場合はダッシュボードを読み込むときにデータソースを選び直してください）。

### (2) 画面で設定する（IAM 認証）

「Connections」→「Data sources」→「Add new data source」→「Infinity」を選び、次のように設定します。

| タブ | 項目 | 値 |
|---|---|---|
| URL, Headers & Params | Base URL | デプロイの出力 `Endpoint`（末尾の `/` まで） |
| Authentication | Auth type | AWS |
| Authentication | Authentication Provider | Access and secret key |
| Authentication | Region | デプロイの出力 `Region` |
| Authentication | Service | `execute-api`（関数 URL なら `lambda`） |
| Authentication | Access Key ID / Secret Access Key | Grafana 用 IAM ユーザーのアクセスキー |
| Health check | （カスタムのヘルスチェック） | 有効にし、URL に `<Endpoint>datasets` |

「Save & test」で /datasets を呼び、成功すれば設定は完了です。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/datasource-dark.png">
  <img alt="データソースの設定（Authentication）" src="../images/datasource-light.png">
</picture>

- Service の既定は `monitoring` です。必ず `execute-api` か `lambda` に変えてください（変えないと署名が合わず 403 になります）
- Base URL を設定すると、クエリの URL（`query`、`keys`）はその後ろにつながります。この場合、「Security」の Allowed hosts は不要です

### (3) 画面で設定する（API キー認証）

`-c auth=apiKey` でデプロイした場合です。キーの値は、デプロイの出力 `GetApiKeyCommand` のコマンドで取得します。

```bash
aws apigateway get-api-key --api-key <ID> --include-value --query value --output text
```

| タブ | 項目 | 値 |
|---|---|---|
| URL, Headers & Params | Base URL | デプロイの出力 `Endpoint` |
| Authentication | Auth type | API Key Value pair |
| Authentication | Key | `x-api-key` |
| Authentication | Value | 取得した API キー |
| Authentication | （付け方） | Header |

## 3.3 環境ごとの注意

### (1) セルフホスト（ローカルの Docker）

[導入](01-getting-started.md#17-grafana-で表示する) の手順です。`pnpm grafana-up` で、データソース、サンプルダッシュボード、アラートルールが読み込まれます。

| 項目 | 内容 |
|---|---|
| URL | http://localhost:3000/（127.0.0.1 だけで待ち受け） |
| ログイン | 閲覧はログイン不要。編集は admin / admin |
| Linux | `-f grafana/docker-compose.linux.yml` を重ねる（`host.docker.internal` をホストに向けるため） |
| 停止 | `pnpm grafana-down` |

### (2) セルフホスト（EC2 など、ロールを使う）

アクセスキーを置かずに、EC2 のインスタンスロール（ECS のタスクロール、EKS の IRSA なども同様）で署名できます。

1. インスタンスロールに、デプロイの出力 `GrafanaPolicyArn` のポリシーを付けます
2. データソースの Authentication Provider を「AWS SDK Default」にします（provisioning なら `jsonData.aws.authType: default`）

Grafana の設定（grafana.ini の `[aws] allowed_auth_providers`）で `default` が許可されている必要があります。Grafana OSS の既定では許可されています。

別のアカウントのロールを引き受ける場合は、`-c grafanaRoleTrust=<引き受ける側の ARN>` でデプロイし、出力の `GrafanaRoleArn` をデータソースの Assume Role ARN に設定します。

### (3) Grafana Cloud（未検証）

- AWS SDK Default は使えません。Grafana 用 IAM ユーザーのアクセスキーで「Access and secret key」を使うか、`-c auth=apiKey` でデプロイして API キーを使います
- Grafana Cloud からは、インターネット経由で API を呼びます。`restPublic`（既定）か `functionUrl` でデプロイしてください（`restPrivate` には届きません）
- API キー認証では、使用量プラン（`-c throttleRate` / `-c throttleBurst`）でレートを制限できます

### (4) Amazon Managed Grafana（未検証）

- Infinity は、ワークスペースのプラグイン管理から入れます
- アクセスキーを使う「Access and secret key」で接続します。ワークスペースのロールを使う方法（AWS SDK Default）が使えるかは未確認です
- ワークスペースの利用には IAM Identity Center または SAML の設定が必要です

## 3.4 ダッシュボードを読み込む

サンプルダッシュボードは `grafana/dashboards/room-temp.json` です。provisioning を使わない場合は、「Dashboards」→「New」→「Import」でこのファイルを読み込み、データソースを選びます。

自分のデータセットのパネルを作る方法は [パネルとアラート](04-panels-and-alerts.md) を参照してください。

## 次に読む

- [パネルとアラート](04-panels-and-alerts.md)
- [デプロイオプション](05-deployment-options.md)
