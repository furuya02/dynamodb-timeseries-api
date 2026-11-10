# 2. データセットの定義

[English](../en/02-datasets.md) | 日本語 ｜ [手順書の目次](../README.md)

自分の DynamoDB テーブルを Grafana から見られるようにする手順です。設定は `config/datasets.yaml` の 1 ファイルにまとめます。

## 2.1 データセットとは

1 つのデータセットは「どのテーブルの、どのキーの、どの属性を返すか」の定義です。Grafana からはデータセット名とキーだけを指定します。テーブル名や属性名を Grafana 側に書く必要はありません。

```yaml
datasets:
  room_temp:                        # データセット名（Grafana の dataset パラメータ）
    table: iot-metrics              # テーブル名
    partitionKey: { name: deviceId }
    sortKey: { name: ts, format: epoch_ms }
    keys: { pattern: "^room-[0-9]{2}$" }   # 受け付けるキー
    fields:                         # 返す属性（ここにない属性は返さない）
      - { name: temperature, unit: celsius }
      - { name: humidity, unit: percent }
```

前提は次のとおりです。

- ソートキーが時刻（epoch 秒・epoch ミリ秒・ISO 8601 の文字列）であること
- パーティションキーが「時系列を区別するキー」（デバイス ID など）を含むこと

ソートキーが時刻でないテーブルは扱えません。必要なら、時刻をソートキーにした GSI を作り、`index` で指定します。

## 2.2 下書きを作る（pnpm init-dataset）

```bash
pnpm init-dataset --table <テーブル名> [--index <GSI 名>] [--name <データセット名>] [--sample 100]
```

DescribeTable でキーの名前を調べ、Scan で先頭の 100 件（`--sample`）だけを読みます（数 RCU 程度）。読んだアイテムから次の項目を推定し、`config/datasets.yaml` の下書きを表示します。

- ソートキーの時刻形式とプレフィックス
- パーティションキーのテンプレート（`room#{key}` など）と、日付で分けたキーかどうか
- キーの形（`keys.pattern` の案）
- 属性とその型

```
# check: Keys found: room-01. keys.pattern is a proposal based on their shape (not all keys were read)
  dynamodb_timeseries_api_sample:
    description: dynamodb-timeseries-api-sample
    table: dynamodb-timeseries-api-sample
    partitionKey:
      name: deviceId
    sortKey:
      name: ts
      format: epoch_ms
    keys:
      pattern: ^room-[0-9]{2}$
    fields:
      - name: temperature
        type: number
      - name: humidity
        type: number
```

`# check:` の注記は必ず読んでください。主な注記は次のとおりです（メッセージは英語です）。

| 注記 | 対応 |
|---|---|
| Keys found ... keys.pattern is a proposal based on their shape | Scan の先頭は一部のパーティションに偏ります。キーの形が合っているか確かめます |
| The sort key has multiple types | シングルテーブル設計で TEMP# と HUM# などが混在しています。多い方で推定したので、ほかの種類は `prefix` を変えた別のデータセットにします |
| N items have a different sort key format | 登録用アイテムなど、時系列でないアイテムを推定から除いています |
| The sort key has no time zone | UTC 以外で保存しているなら `sortKey.timezone` を指定します |
| The partition key is split by date | 日付の区切りが UTC 以外なら `partitionKey.timezone` を指定します |
| ... has mixed types | `type` を確かめます |

## 2.3 テーブル設計ごとの書き方

### (1) デバイス ID + epoch ミリ秒

```yaml
room_temp:
  table: iot-metrics
  partitionKey: { name: deviceId }
  sortKey: { name: ts, format: epoch_ms }
  keys: { pattern: "^room-[0-9]{2}$" }
  fields:
    - { name: temperature, unit: celsius }
```

### (2) シングルテーブル設計（プレフィックス付きのキー）

PK = `room#a`、SK = `TEMP#2025-11-03T00:00:00Z` のように、種類を表すプレフィックスが付いている場合です。

```yaml
room_temp_single:
  table: app-table
  partitionKey: { name: pk, template: "room#{key}" }
  sortKey: { name: sk, format: iso8601, prefix: "TEMP#" }
  keys: { values: [a, b, c] }
  fields:
    - { name: value, alias: temperature }
```

- `template` の `{key}` が、Grafana から指定するキーに置き換わります
- `prefix` を付けると、同じ PK の HUM# などは読みません

### (3) 日付で分けたパーティションキー

ホットパーティションを避けるために、PK を `device-1#2025-11-03` のように日ごとに分けている場合です。

```yaml
power:
  table: power-logs
  partitionKey: { name: pk, template: "{key}#{yyyy-MM-dd}", bucket: daily, timezone: Asia/Tokyo }
  sortKey: { name: ts, format: epoch_s }
  keys: { pattern: "^device-[0-9]+$" }
  fields:
    - { name: watt }
```

- 期間内の日付ごとに Query を実行し、結果をまとめて返します
- `timezone` は「どのタイムゾーンの日付で分けたか」です。JST の日付で分けたテーブルを UTC として読むと、9 時間分を取りこぼします
- 月で分けている場合は `bucket: monthly` と `{yyyy-MM}` を使います

```mermaid
flowchart LR
  Q["key=device-1<br/>2025-11-03 10:00 → 11-05 08:00 (JST)"] --> P1["Query pk = device-1#2025-11-03"]
  Q --> P2["Query pk = device-1#2025-11-04"]
  Q --> P3["Query pk = device-1#2025-11-05"]
  P1 --> M["まとめて時刻で絞り込み、<br/>並べ替える"]
  P2 --> M
  P3 --> M
```

### (4) オフセットのない ISO 8601

保存値が `2025-11-03T09:00:00` のように、オフセットのない JST の時刻の場合です。

```yaml
sortKey: { name: ts, format: iso8601, timezone: Asia/Tokyo }
```

`Z` や `+09:00` が付いた値は、その表記どおりに読みます。`.000Z` の有無など末尾の違いは自動で吸収します。

### (5) GSI を使う

```yaml
by_room:
  table: sensor-events
  index: byRoom
  partitionKey: { name: room }        # GSI のキー
  sortKey: { name: ts, format: epoch_ms }
  keys: { pattern: "^r[0-9]+$" }
  fields:
    - { name: v }
```

Lambda には、そのインデックスへの `dynamodb:Query` だけが付きます。

### (6) 値の換算とネストした属性

```yaml
fields:
  - { name: temp_x10, alias: temperature, scale: 0.1, unit: celsius }  # 整数で保存した値を 0.1 倍
  - { name: meta.fw, type: string }                                       # ネスト属性。列名は meta_fw
  - { name: meta, type: json, alias: meta_json }                          # Map 全体を JSON 文字列で
  - { name: online, type: boolean }                                       # true / 1 / "TRUE" / "1" → true
```

## 2.4 キーの許可と一覧

`keys.pattern`（正規表現）か `keys.values`（列挙）のどちらかが必須です。指定されたキーがどちらにも合わなければ、API は 400 を返します。任意のキーで任意のパーティションを読まれないようにするためです。

Grafana のプルダウン（テンプレート変数）には、`GET /keys` がキーの一覧を返します。

| 設定 | /keys が返すもの |
|---|---|
| `keys.values` | その値 |
| `keys.list: { partitionValue, attribute }` | 同じテーブル（インデックス）の、パーティションキー = `partitionValue` のアイテムの `attribute` の値。pattern / values に合わないものは除く |
| どちらもない | 空の配列（理由はヘッダー `x-tsapi-hint`） |

キー一覧のためにテーブルを Scan することはしません。デバイスが増減するテーブルでは、登録用のアイテムを置いて `keys.list` を使います。

```yaml
keys:
  pattern: "^room-[0-9]{2}$"
  list: { partitionValue: devices, attribute: id }   # deviceId = "devices" のアイテムの id を一覧にする
```

## 2.5 上限とキャッシュ

```yaml
defaults:                 # 全データセットの既定値
  limits: { maxRange: 7d }
  cacheTtlSeconds: 60
datasets:
  room_temp:
    ...
    limits:               # データセットごとに上書き
      maxRange: 31d
      maxItems: 50000
```

| 項目 | 既定値 | 内容 |
|---|---|---|
| `limits.maxRange` | `31d` | 1 回で問い合わせられる期間（`90m` / `12h` / `31d`）。超えると 400 |
| `limits.maxItems` | `50000` | 読む件数の上限。達したら打ち切り |
| `limits.maxPages` | `100` | 読むページ数の上限 |
| `limits.maxRcu` | `1000` | 消費 RCU の上限。超えた時点で次のページを読まない |
| `limits.maxKeys` | `20` | 一度に指定できるキーの数。超えると 400 |
| `cacheTtlSeconds` | `30` | 応答キャッシュの秒数（0 で無効） |

打ち切った場合、応答の `meta.truncated` が `true` になり、`meta.truncatedBy` にどの上限かが入ります。上限の考え方は [運用とトラブルシューティング](06-operations.md#63-上限の調整) を参照してください。

## 2.6 設定一覧

| 項目 | 既定値 | 説明 |
|---|---|---|
| `description` | | 説明（`/datasets` で返す） |
| `table` | 必須 | テーブル名 |
| `index` | | GSI 名 |
| `partitionKey.name` | 必須 | パーティションキーの属性名 |
| `partitionKey.template` | `{key}` | キーの組み立て方。`{key}` は必須。日付で分けるなら `{yyyy-MM-dd}` / `{yyyy-MM}` |
| `partitionKey.bucket` | `none` | `daily` / `monthly`（template の日付トークンと合わせる） |
| `partitionKey.timezone` | `UTC` | 日付の区切りのタイムゾーン（bucket があるときだけ） |
| `sortKey.name` | 必須 | ソートキーの属性名 |
| `sortKey.format` | 必須 | `epoch_s` / `epoch_ms` / `iso8601` |
| `sortKey.prefix` | `""` | 複合ソートキーのプレフィックス |
| `sortKey.timezone` | `UTC` | オフセットのない ISO 8601 の解釈（`iso8601` のときだけ） |
| `keys.pattern` | | 受け付けるキーの正規表現 |
| `keys.values` | | 受け付けるキーの列挙 |
| `keys.list.partitionValue` / `keys.list.attribute` | | キー一覧を読む登録用アイテム |
| `fields[].name` | 必須 | 属性名。`a.b` でネスト属性。ソートキーは書かない（時刻列として自動で返す） |
| `fields[].alias` | | 列名（既定は `.` を `_` にした属性名）。列名は重複できない |
| `fields[].type` | `number` | `number` / `string` / `boolean` / `json` |
| `fields[].unit` | | 単位 |
| `fields[].scale` | | 掛け算での換算（`number` のときだけ） |
| `limits.*` | 上の表 | 上限 |
| `cacheTtlSeconds` | `30` | 応答キャッシュの秒数 |

データセット名は、英小文字で始まり、英小文字・数字・`_` のみ（64 文字以内）です。

タイムゾーンは `UTC`、`+09:00` のようなオフセット、`Asia/Tokyo` のような IANA 名で指定します。

## 2.7 設定の誤りとデプロイ

設定ファイルに誤りがあると、`cdk synth` / `cdk deploy` の時点で、どのデータセットのどの項目が誤りかを一覧で表示して止まります。

```
The configuration file has errors: config/datasets.yaml
  - datasets.room_temp.partitionKey.template: Include {yyyy-MM-dd} when bucket is daily
  - datasets.room_temp.keys: Specify pattern or values (to restrict the accepted keys; list is only for listing keys and does not restrict them)
```

型の誤り（文字列のところに数値など）を直すと、項目の組み合わせに関する誤りが追加で表示されることがあります。

設定を変えたら、デプロイし直します。Lambda に同梱される設定と IAM の権限が更新されます。

```bash
pnpm cdk-deploy -c grafanaUser=true          # 前回と同じ -c を付ける
pnpm check --dataset <データセット名> --key <キー>
```

別の設定ファイルを使う場合は `-c config=path/to/datasets.yaml` を指定します。

## 2.8 よくある誤り

| 症状 | 原因 |
|---|---|
| 500 `ValidationException: ... Condition parameter type does not match schema type` | `sortKey.format` とテーブルの型が違う（数値のソートキーに `iso8601` など）。または `prefix` の有無が違う |
| 0 件が返る | `template` / `prefix` / `timezone` の違いで、存在しないパーティション・範囲を読んでいる。`pnpm init-dataset` の結果と比べる |
| 値が `null` | 属性名の誤り、または `type` に変換できない値（`number` に `"abc"` など） |
| 500 `ResourceNotFoundException` | テーブル名・インデックス名の誤り、またはリージョンが違う |
| 404 `Dataset X is not defined` | 設定を変えたあと、デプロイし直していない（設定は Lambda に同梱されるため） |

## 次に読む

- [Grafana との接続](03-grafana.md)
- [パネルとアラート](04-panels-and-alerts.md)
