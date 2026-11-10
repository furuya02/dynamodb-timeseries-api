# 5. デプロイオプション

[English](../en/05-deployment-options.md) | 日本語 ｜ [手順書の目次](../README.md)

`pnpm cdk-deploy -c 名前=値` で、公開形態や認証方式を選べます。誤った値や組み合わせは、synth の時点でまとめて表示して止まります。

## 5.1 オプション一覧

どの組み合わせを選ぶかの目安です。

```mermaid
flowchart TD
  Q1{"Grafana はどこで動く？"}
  Q1 -->|"VPC の中<br/>（インターネットに出さない）"| P["exposure=restPrivate<br/>+ vpcEndpointId"]
  Q1 -->|"それ以外"| Q2{"API キーや<br/>使用量プランが必要？"}
  Q2 -->|はい| K["auth=apiKey<br/>（restPublic）"]
  Q2 -->|いいえ| Q3{"API Gateway を<br/>使わない？"}
  Q3 -->|はい| F["exposure=functionUrl"]
  Q3 -->|いいえ| R["restPublic + iam<br/>（既定）"]
  P --> W{"Grafana の AWS の<br/>認証情報は？"}
  F --> W
  R --> W
  W -->|"アクセスキー"| U["-c grafanaUser=true"]
  W -->|"ロールを引き受ける"| T["-c grafanaRoleTrust=ARN"]
  W -->|"自分のロール（EC2 など）"| E["GrafanaPolicyArn を付ける"]
```

| 名前 | 既定値 | 値 |
|---|---|---|
| `config` | `config/datasets.yaml` | 設定ファイルのパス |
| `exposure` | `restPublic` | `restPublic` / `functionUrl` / `restPrivate` |
| `auth` | `iam` | `iam` / `apiKey` |
| `vpcEndpointId` | | `vpce-` で始まる ID（`restPrivate` のとき必須） |
| `grafanaUser` | `false` | `true` で Grafana 用 IAM ユーザーを作る（`auth=iam` のとき） |
| `grafanaRoleTrust` | | Grafana 用ロールを引き受けられる ARN（`auth=iam` のとき） |
| `logRetentionDays` | `7` | CloudWatch Logs の保持日数（1 / 3 / 5 / 7 / 14 / 30 / 60 / 90 / 120 / 150 / 180 / 365 / 400 / 545 / 731 / 1096 / 1827 / 2192 / 2557 / 2922 / 3288 / 3653） |
| `throttleRate` / `throttleBurst` | `10` / `20` | 使用量プランのレート（1 秒あたり）とバースト（`auth=apiKey` のとき） |
| `sample` | `false` | `true` でサンプルテーブルを作る |
| `cold` / `coldIngest` / `coldScanLimitGb` / `coldRemovalPolicy` / `bucket_suffix` | | コールドストア（[コールドストア](09-cold-storage.md#91-有効にする)） |

`pnpm cdk-destroy` はスタックごと削除します。削除のときも、デプロイと同じ `-c` を付けておくのが確実です（手順書の例はそのように書いています）。

## 5.2 公開形態（exposure）

![公開形態の比較](../images/exposure.png)

| 値 | 入口 | 向いている環境 | 費用 |
|---|---|---|---|
| `restPublic`（既定） | API Gateway の REST API（REGIONAL）。ステージ `v1` | ほとんどの場合 | REST API のリクエスト課金 |
| `functionUrl` | Lambda の関数 URL（IAM 認証） | API Gateway の機能（API キー、使用量プラン）が不要な場合 | 関数 URL 自体は無料（Lambda の料金のみ） |
| `restPrivate` | プライベートな REST API。指定した VPC エンドポイントからだけ呼べる | Grafana が VPC 内にあり、インターネットに出したくない場合 | REST API のリクエスト課金（VPC エンドポイントは別途） |

### (1) restPrivate

VPC も VPC エンドポイントも作りません。既存の、execute-api のインターフェイス型 VPC エンドポイントの ID を指定します。

```bash
pnpm cdk-deploy -c exposure=restPrivate -c vpcEndpointId=vpce-0123456789abcdef0
```

リソースポリシーで、指定した VPC エンドポイント以外からの呼び出しを拒否します。許可するプリンシパルは、`auth=iam` ならこのアカウント、`auth=apiKey` なら誰でも（キーで絞る）です。

restPrivate は synth の結果で確かめていますが、実際の VPC からの呼び出しは確かめていません。

## 5.3 認証方式（auth）

![認証方式の比較](../images/auth.png)

| 値 | 仕組み | 使える公開形態 |
|---|---|---|
| `iam`（既定） | SigV4 署名。Grafana には API を呼ぶ権限だけを渡す | すべて |
| `apiKey` | `x-api-key` ヘッダー。使用量プランでレートを制限 | `restPublic` / `restPrivate` |

### (1) IAM 認証の権限

`auth=iam` のとき、API を呼ぶ権限だけを持つ管理ポリシー `dynamodb-timeseries-api-invoke` を作ります。

| 公開形態 | ポリシーの中身 |
|---|---|
| REST API | `execute-api:Invoke`（ステージ `v1` の GET のみ） |
| 関数 URL | `lambda:InvokeFunctionUrl`（条件 `lambda:FunctionUrlAuthType = AWS_IAM`）と、関数 URL 経由に限った `lambda:InvokeFunction`（条件 `lambda:InvokedViaFunctionUrl = true`）。AWS CDK の `grantInvokeUrl` と同じ |

このポリシーの渡し方は 3 通りです。

| 方法 | オプション | 使う場面 |
|---|---|---|
| IAM ユーザー | `-c grafanaUser=true` | ローカル、Grafana Cloud、Amazon Managed Grafana（アクセスキー） |
| ロール | `-c grafanaRoleTrust=<ARN>` | 別アカウントの Grafana などから Assume Role |
| 既存のロールに付ける | 出力の `GrafanaPolicyArn` | EC2 のインスタンスロールなど |

IAM ユーザーのアクセスキーは CDK では作りません（キーが CloudFormation の外に出にくい形で残らないようにするため）。出力の `CreateAccessKeyCommand` で作り、使わなくなったら削除します。

### (2) API キー

```bash
pnpm cdk-deploy -c auth=apiKey -c throttleRate=10 -c throttleBurst=20
```

キーの値は CloudFormation の出力に出しません。出力の `GetApiKeyCommand` のコマンドで取得します。`pnpm check` と `pnpm grafana-config` は、このキーを自動で使います。

使用量プランのバーストは厳密な上限ではありません。60 リクエストを同時に送ったところ、429 は 1 件だけでした（設定は rate 10 / burst 20）。

## 5.4 構成を変えるときの注意

- `auth=iam` から `auth=apiKey` に変えると、Grafana 用 IAM ユーザーは削除されます。CDK の管理外で作ったアクセスキーが残っていると削除に失敗するので、先にキーを削除します
- `exposure` を変えると、エンドポイント（URL）が変わります。Grafana のデータソースの Base URL を更新します（`pnpm grafana-config` で作り直せます）
- 論理 ID は将来のバージョンでも変えない方針です。既存の環境に新しいバージョンをデプロイしても、ロググループや API が作り直されることはありません

## 5.5 作られるリソースと名前

| リソース | 名前 | 条件 |
|---|---|---|
| Lambda 関数 | `dynamodb-timeseries-api`（Node.js 24、arm64、512MB、29 秒） | 常に |
| ロググループ | `/aws/lambda/dynamodb-timeseries-api` | 常に |
| REST API | `dynamodb-timeseries-api`（ステージ `v1`） | `restPublic` / `restPrivate` |
| 関数 URL | | `functionUrl` |
| 管理ポリシー | `dynamodb-timeseries-api-invoke` | `auth=iam` |
| IAM ユーザー | `dynamodb-timeseries-api-grafana` | `grafanaUser=true` |
| IAM ロール | `dynamodb-timeseries-api-grafana` | `grafanaRoleTrust` |
| API キー / 使用量プラン | `dynamodb-timeseries-api-grafana` / `dynamodb-timeseries-api` | `auth=apiKey` |
| DynamoDB テーブル | `dynamodb-timeseries-api-sample` | `sample=true` |
| S3 バケット、Glue、Athena ワークグループ、取り込みの Lambda / Firehose | [コールドストア](09-cold-storage.md#92-作られるリソース) | `cold=true` |

名前はアカウント・リージョン内で一意である必要があります。同じアカウント・リージョンに 2 つ目をデプロイすることは、今のバージョンでは想定していません。

Lambda の実行ロールには、`datasets.yaml` に書いたテーブル・インデックスへの `dynamodb:Query` だけを付けます。

## 次に読む

- [運用とトラブルシューティング](06-operations.md)
