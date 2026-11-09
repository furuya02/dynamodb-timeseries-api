# 4. パネルとアラート

[English](../en/04-panels-and-alerts.md) | 日本語 ｜ [手順書の目次](../README.md)

Infinity のクエリで、API（`GET /query`）を呼んでパネルを作る方法です。サンプルダッシュボード（`grafana/dashboards/room-temp.json`）にすべての例があります。

## 4.1 基本のクエリ

パネルの編集画面で、データソースに dynamodb-timeseries-api（Infinity）を選び、次のように設定します。

| 項目 | 値 | 補足 |
|---|---|---|
| Type | JSON | |
| Parser | JSONata | バックエンドで動くパーサー（JQ も可）。アラートに使うために必要（Frontend / UQL / GROQ はアラートで動かない） |
| Source | URL | |
| URL | `query` | データソースの Base URL の後ろにつながる |
| Method | GET | |
| URL Query Params | 下の表 | |
| Rows / Root | `rows` | |
| Columns | `time`（Time ( UNIX ms )）、`key`（String）、値の列（Number） | Rows / Root と Columns は「Parsing options & Result fields」を開いて設定する |
| Format | Time Series | |

URL Query Params:

| Key | Value |
|---|---|
| `dataset` | データセット名（例: `room_temp`） |
| `key` | `${key:csv}`（テンプレート変数。固定なら `room-01,room-02`） |
| `from` | `${__from}` |
| `to` | `${__to}` |
| `interval` | `${__interval_ms}`（表示期間に合わせて API 側で集計する） |
| `agg` | `avg` |
| `fields` | 返す列（例: `temperature`。省略すると全列） |

応答の `rows` は「1 行 = 時刻 × キー」の long 形式です。Format を Time Series にすると、Infinity が key ごとの系列に変換し、key がラベルになります。凡例を部屋の名前だけにするには、パネルの「Standard options」→「Display name」を `${__field.labels.key}` にします。

## 4.2 テンプレート変数（キーのプルダウン）

「Dashboard settings」→「Variables」→「New variable」で作ります。

| 項目 | 値 |
|---|---|
| Variable type | Query |
| Data source | dynamodb-timeseries-api |
| Query type | Infinity |
| Type / Parser / Source | JSON / JSONata / URL |
| URL | `keys` |
| URL Query Params | `dataset` = データセット名 |
| Columns | `key`（String） |
| Multi-value / Include All option | 有効 |

クエリでは `${key:csv}` と書きます。複数選択すると `room-01,room-02` のようにカンマ区切りで渡ります。キーの一覧が空になる場合は、データセットに `keys.values` か `keys.list` が必要です（[データセットの定義](02-datasets.md#24-キーの許可と一覧)）。

## 4.3 よく使うクエリ

| 目的 | パラメータ | パネル |
|---|---|---|
| 推移（表示期間に合わせて集計） | `interval=${__interval_ms}&agg=avg` | Time series |
| 生データ | `interval` を付けない | Time series / Table |
| 最新値 | `latest=1` | Stat / Gauge |
| 1 日ごとの最高・最低 | `interval=1d&agg=max`（別のクエリで `agg=min`）、`tz=Asia/Tokyo` | Time series（Bars）/ Bar chart |
| 件数 | `interval=1h&agg=count` | Time series（Bars） |
| 複数キーを列で並べる | `format=wide`（列名は `キー_列名`） | Table |
| API の情報 | Rows / Root を `meta` にし、Format を Table | Table |

### (1) 集計（interval / agg）

- `interval` は `$__interval_ms`（ミリ秒）か、`30s` / `5m` / `1h` / `1d` の形式です
- `agg` は `avg`（既定）/ `min` / `max` / `sum` / `count` / `last` です
- 欠損（null）は集計から除きます。数値以外の列は、`avg` などでは区切りの最後の値を、`count` では件数を返します
- 区切りはタイムゾーンの壁時計で決まります。既定はデータセットのタイムゾーン（日付で分けたキーなら `partitionKey.timezone`、なければ `sortKey.timezone`）で、`tz=Asia/Tokyo` のように上書きできます
- 集計しても、DynamoDB から読む件数と消費 RCU は変わりません。減るのは応答の大きさと Grafana の負荷です

### (2) 最新値（latest=1）

キーごとに、期間内の最新の 1 件を返します。新しい順に読み、範囲内の 1 件が見つかった時点で止めるので、期間を長くしても読み込み量はほとんど増えません。Stat パネルやアラートに向いています。`interval` とは同時に指定できません。

### (3) API の情報（meta）

Rows / Root を `meta`、Format を Table にすると、同じ問い合わせの情報を表示できます。

| 列 | 内容 |
|---|---|
| `points` | 返した点の数 |
| `items` | DynamoDB から読んだ件数 |
| `pages` | 読んだページ数 |
| `consumedRcu` | 消費 RCU |
| `truncated` / `truncatedBy` | 上限による打ち切りと、その上限 |
| `cache` | キャッシュの hit / miss |

## 4.4 アラート

アラートは Grafana のバックエンドで評価されます。そのため、ダッシュボードとは次の点が違います。

| 項目 | ダッシュボード | アラート |
|---|---|---|
| `${__from}` / `${__to}` | 使える | 使える（Infinity のバックエンドが置き換える） |
| `${__interval_ms}` | 使える | 使えない（置き換わらない） |
| テンプレート変数（`${key:csv}`） | 使える | 使えない |
| Parser | どれでも | Backend のグループ（JSONata / JQ）だけ |

アラートのクエリでは、`key` に値を直接書き、`latest=1` か固定の `interval`（`5m` など）を使います。置き換わらない変数が届くと、API は「Grafana の変数が置き換えられていません」という 400 を返します。

サンプルのアラートルール（`grafana/provisioning/alerting/room-temp.yaml`）は、最新の温度が 29℃ を超えた状態が 5 分続いたら発火します。

| 手順 | 設定 |
|---|---|
| A（クエリ） | `dataset=room_temp`、`key=room-01,room-02,room-03`、`from=${__from}`、`to=${__to}`、`latest=1`、`fields=temperature`、Format: Time Series |
| B（Reduce） | A の Last |
| C（Threshold） | B が 29 を超える |
| 評価 | 1 分ごと、5 分続いたら発火 |

key ごとの系列になるため、アラートも部屋ごとに評価されます（多次元アラート）。通知の文面では `{{ $labels.key }}` で部屋の名前を使えます。

## 4.5 Grafana に「400 Bad Request」とだけ表示されたら

Infinity は、API が 400 以上の応答を返すと、応答の本文（理由）を表示しません。理由は次のどちらかで確かめます。

- 同じ条件で `pnpm check --dataset <名前> --key <キー>` を実行する、または API を直接呼ぶ
- CloudWatch Logs（`/aws/lambda/dynamodb-timeseries-api`）の `error` を見る（[運用とトラブルシューティング](06-operations.md#61-ログ)）

## 次に読む

- [デプロイオプション](05-deployment-options.md)
- [API リファレンス](07-api-reference.md)
