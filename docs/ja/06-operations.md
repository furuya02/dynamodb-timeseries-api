# 6. 運用とトラブルシューティング

[English](../en/06-operations.md) | 日本語 ｜ [手順書の目次](../README.md)

## 6.1 ログ

Lambda は、1 リクエストにつき 1 行の JSON をロググループ `/aws/lambda/dynamodb-timeseries-api` に書きます（保持期間は `-c logRetentionDays`、既定 7 日）。

```json
{"requestId":"e68dd40f-...","type":"query","status":200,"dataset":"room_temp","keys":3,"rangeMs":86399999,"interval":300000,"agg":"avg","format":"long","cache":"miss","queries":3,"pages":3,"items":4320,"consumedRcu":25.5,"points":864,"durationMs":254}
```

| 項目 | 内容 |
|---|---|
| `requestId` | Lambda のリクエスト ID（同じロググループの REPORT 行と突き合わせられる） |
| `type` | `query` / `keys` / `datasets` / `unknown` |
| `status` | HTTP ステータス |
| `error` | 400 / 404 / 500 の理由（Grafana には表示されない） |
| `cache` | `hit` / `miss` |
| `queries` / `pages` / `items` / `consumedRcu` | DynamoDB の読み込み（キャッシュに当たったときは出さない） |
| `truncatedBy` | 打ち切った上限 |
| `points` / `durationMs` | 返した点の数と所要時間 |

### (1) CloudWatch Logs Insights の例

```
# データセットごとのリクエスト数、消費 RCU、平均所要時間
filter type = "query"
| stats count(*) as requests, sum(consumedRcu) as rcu, avg(durationMs) as avgMs by dataset, cache

# エラーの一覧
filter status >= 400
| fields @timestamp, status, dataset, error
| sort @timestamp desc

# 上限で打ち切ったリクエスト
filter ispresent(truncatedBy)
| stats count(*) by dataset, truncatedBy
```

`stats` の別名は、元の項目名と違う名前にしてください。`sum(items) as items` のように同じ名前にすると、結果に列が出ないことがありました。

## 6.2 費用の目安

| 項目 | 課金のされ方 |
|---|---|
| DynamoDB の読み込み | 消費 RCU（オンデマンドなら読み込みリクエスト単位）。集計しても減らない。減らせるのは `latest=1` と期間の短縮 |
| Lambda | リクエスト数と実行時間（512MB、arm64） |
| API Gateway（REST） | リクエスト数（関数 URL は無料） |
| CloudWatch Logs | 取り込みと保存 |

実測（3 部屋 × 7 日分、1 分おき、ap-northeast-1）:

| 問い合わせ | 読んだ件数 | 消費 RCU | 応答時間 | 応答サイズ |
|---|---|---|---|---|
| 1 キー 1 時間 生データ | 57 | 0.5 | 219ms | 4KB |
| 3 キー 24 時間 5 分平均 | 4,320 | 25.5 | 254ms | 64KB |
| 3 キー 7 日 生データ | 30,231 | 177 | 1,226ms | 2,173KB |
| 3 キー 7 日 1 時間平均 | 30,240 | 177 | 1,016ms | 43KB |
| 3 キー 7 日 最新値 | 3 | 1.5 | 69ms | 0KB |

ダッシュボードの自動更新は、パネルの数 × 更新回数だけ API を呼びます。応答キャッシュ（既定 30 秒）と、集計時の時刻の丸めにより、同じ区切りの問い合わせはキャッシュから返ります。

## 6.3 上限の調整

| 上限 | 超えたとき | 調整の目安 |
|---|---|---|
| `maxRange` | 400 | ダッシュボードで選べる最大の期間に合わせる |
| `maxKeys` | 400 | テンプレート変数で選べるキーの数に合わせる |
| `maxItems` / `maxPages` / `maxRcu` | 打ち切り（`truncated: true`） | 期間 × キー数 × 1 キーあたりの件数で見積もる |
| 応答サイズ（5.5MB） | 400「応答が大きすぎます」 | `interval` で集計する、期間を短くする、`fields` で列を減らす |

- `maxRcu` は「超えた時点で次のページを読まない」方式です。1 ページ（最大 1MB、約 128 RCU）分を超えることがあります
- 複数のキー・日付を並列に読むため、`maxItems` を同時に読んだページの分だけ超えることがあります（最大 8 ページ分）
- Lambda の応答は 6MB が上限です。超えると API Gateway が 502 を返して理由がわからないため、5.5MB を超える応答は理由つきの 400 にしています

## 6.4 トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| Grafana に `status code : 400 Bad Request` とだけ表示される | Infinity は 4xx の本文を表示しません。`pnpm check` で同じ条件を試すか、ログの `error` を見ます |
| `Grafana の変数が置き換えられていません` | アラート（またはダッシュボード以外）のクエリで、テンプレート変数や `$__interval_ms` を使っています。値を直接書きます |
| データソースのテストで 403 | IAM: 署名に使うキーに `dynamodb-timeseries-api-invoke` の権限があるか、Service が `execute-api`（関数 URL は `lambda`）か。API キー: キーが正しいか |
| IAM の権限を変えた直後に 403 になったり 200 になったりする | IAM の変更の反映には数分かかることがあります。少し待ってから確かめます |
| 500 `ValidationException` | `datasets.yaml` のキー名・時刻形式が実際のテーブルと違います（[データセットの定義](02-datasets.md#28-よくある誤り)） |
| 500 `ResourceNotFoundException` | テーブル名・インデックス名の誤り、またはリージョンが違います |
| 404 `データセット X は定義されていません` | 設定を変えたあとデプロイし直していません |
| `応答が大きすぎます` | 上の「上限の調整」を参照 |
| `meta.truncated: true` | 上の「上限の調整」を参照 |
| パネルが空（エラーなし） | 期間内にデータがない、`key` が違う、Columns の名前が応答の列名と違う |
| ローカルの Grafana から `pnpm local-api` に届かない | Linux は `docker-compose.linux.yml` を重ねます。Docker Desktop / Rancher Desktop では重ねません（重ねると届かなくなります） |
| `pnpm check` が `Endpoint がありません` | `AWS_REGION` がデプロイしたリージョンと違うか、スタック名が違います（`--stack` / `--region`） |

## 6.5 片付け

```bash
pnpm grafana-down

# CDK の管理外で作ったアクセスキーを先に削除する（残っていると IAM ユーザーを削除できない）
aws iam list-access-keys --user-name dynamodb-timeseries-api-grafana
aws iam delete-access-key --user-name dynamodb-timeseries-api-grafana --access-key-id AKIA...

# デプロイと同じ -c を付けて削除する
pnpm cdk-destroy -c sample=true -c grafanaUser=true
```

- 削除されるもの: Lambda、REST API / 関数 URL、ロググループ、IAM（ポリシー、ユーザー、ロール）、API キー、使用量プラン、サンプルテーブル（データも消えます）
- 削除されないもの: 自分のテーブル（CDK は名前で参照するだけ）、CDK の bootstrap 用 S3 バケットに残るデプロイ用のアセット

## 6.6 新しいバージョンへの更新

```bash
git pull
pnpm install
pnpm cdk-deploy <前回と同じ -c>
```

変更点は [CHANGELOG.md](../../CHANGELOG.md) を参照してください。

## 次に読む

- [API リファレンス](07-api-reference.md)
