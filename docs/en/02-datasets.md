# 2. Defining datasets

English | [日本語](../ja/02-datasets.md) ｜ [Docs index](../README.md)

This chapter explains how to make your own DynamoDB table viewable from Grafana. All settings go in one file, `config/datasets.yaml`.

## 2.1 What a dataset is

A dataset defines "which attributes of which keys in which table to return". Grafana only specifies the dataset name and the keys. You do not need to write table names or attribute names on the Grafana side.

```yaml
datasets:
  room_temp:                        # dataset name (the dataset parameter in Grafana)
    table: iot-metrics              # table name
    partitionKey: { name: deviceId }
    sortKey: { name: ts, format: epoch_ms }
    keys: { pattern: "^room-[0-9]{2}$" }   # accepted keys
    fields:                         # attributes to return (attributes not listed here are not returned)
      - { name: temperature, unit: celsius }
      - { name: humidity, unit: percent }
```

The prerequisites are:

- The sort key is a time (epoch seconds, epoch milliseconds, or an ISO 8601 string)
- The partition key contains "the key that identifies a time series" (a device ID, etc.)

Tables whose sort key is not a time are not supported. If needed, create a GSI with the time as its sort key and specify it with `index`.

## 2.2 Create a draft (pnpm init-dataset)

```bash
pnpm init-dataset --table <table-name> [--index <gsi-name>] [--name <dataset-name>] [--sample 100]
```

It looks up the key names with DescribeTable and reads only the first 100 items (`--sample`) with Scan (a few RCU). From the items it read, it infers the following and prints a draft of `config/datasets.yaml`.

- The time format and prefix of the sort key
- The partition key template (`room#{key}`, etc.) and whether the key is split by date
- The shape of the keys (a proposal for `keys.pattern`)
- The attributes and their types

The script prints its notes in Japanese, as shown below.

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

Always read the `# check:` notes. The main notes are:

| Note | What to do |
|---|---|
| Keys found / keys.pattern is a proposal based on their shape | The first items of a Scan are biased toward some partitions. Check that the key shape is correct |
| The sort key has multiple types | TEMP#, HUM#, etc. are mixed in a single-table design. The inference used the most common type, so define the other types as separate datasets with a different `prefix` |
| N items have a different sort key format | Items that are not time series, such as registration items, are excluded from the inference |
| The sort key has no time zone | If you store times in a zone other than UTC, specify `sortKey.timezone` |
| The partition key is split by date | If the date boundary is not UTC, specify `partitionKey.timezone` |
| ... has mixed types | Check `type` |

## 2.3 How to write it for each table design

### (1) Device ID + epoch milliseconds

```yaml
room_temp:
  table: iot-metrics
  partitionKey: { name: deviceId }
  sortKey: { name: ts, format: epoch_ms }
  keys: { pattern: "^room-[0-9]{2}$" }
  fields:
    - { name: temperature, unit: celsius }
```

### (2) Single-table design (keys with a prefix)

This is for keys with a prefix that shows the type, such as PK = `room#a` and SK = `TEMP#2025-11-03T00:00:00Z`.

```yaml
room_temp_single:
  table: app-table
  partitionKey: { name: pk, template: "room#{key}" }
  sortKey: { name: sk, format: iso8601, prefix: "TEMP#" }
  keys: { values: [a, b, c] }
  fields:
    - { name: value, alias: temperature }
```

- `{key}` in `template` is replaced with the key specified from Grafana
- With `prefix`, items such as HUM# under the same PK are not read

### (3) Partition key split by date

This is for tables that split the PK by day, such as `device-1#2025-11-03`, to avoid hot partitions.

```yaml
power:
  table: power-logs
  partitionKey: { name: pk, template: "{key}#{yyyy-MM-dd}", bucket: daily, timezone: Asia/Tokyo }
  sortKey: { name: ts, format: epoch_s }
  keys: { pattern: "^device-[0-9]+$" }
  fields:
    - { name: watt }
```

- A Query runs for each date in the period, and the results are returned together
- `timezone` is "the time zone of the dates used for the split". If you read a table split by JST dates as UTC, you miss 9 hours of data
- For monthly splits, use `bucket: monthly` and `{yyyy-MM}`

```mermaid
flowchart LR
  Q["key=device-1<br/>2025-11-03 10:00 → 11-05 08:00 (JST)"] --> P1["Query pk = device-1#2025-11-03"]
  Q --> P2["Query pk = device-1#2025-11-04"]
  Q --> P3["Query pk = device-1#2025-11-05"]
  P1 --> M["merge, filter by time,<br/>sort"]
  P2 --> M
  P3 --> M
```

### (4) ISO 8601 without an offset

This is for stored values that are JST times without an offset, such as `2025-11-03T09:00:00`.

```yaml
sortKey: { name: ts, format: iso8601, timezone: Asia/Tokyo }
```

Values with `Z` or `+09:00` are read as written. Differences at the end, such as with or without `.000Z`, are handled automatically.

### (5) Use a GSI

```yaml
by_room:
  table: sensor-events
  index: byRoom
  partitionKey: { name: room }        # GSI key
  sortKey: { name: ts, format: epoch_ms }
  keys: { pattern: "^r[0-9]+$" }
  fields:
    - { name: v }
```

The Lambda function only gets `dynamodb:Query` on that index.

### (6) Value conversion and nested attributes

```yaml
fields:
  - { name: temp_x10, alias: temperature, scale: 0.1, unit: celsius }  # multiply a value stored as an integer by 0.1
  - { name: meta.fw, type: string }                                       # nested attribute. Column name is meta_fw
  - { name: meta, type: json, alias: meta_json }                          # the whole Map as a JSON string
  - { name: online, type: boolean }                                       # true / 1 / "TRUE" / "1" → true
```

## 2.4 Allowed keys and key list

Either `keys.pattern` (regular expression) or `keys.values` (list) is required. If a specified key matches neither, the API returns 400. This prevents reading any partition with any key.

For Grafana drop-downs (template variables), `GET /keys` returns the list of keys.

| Setting | What /keys returns |
|---|---|
| `keys.values` | Those values |
| `keys.list: { partitionValue, attribute }` | The `attribute` values of items in the same table (index) whose partition key = `partitionValue`. Values that do not match pattern / values are excluded |
| Neither | An empty array (the reason is in the `x-tsapi-hint` header) |

The table is never scanned to get the key list. For tables where devices are added and removed, put a registration item in the table and use `keys.list`.

```yaml
keys:
  pattern: "^room-[0-9]{2}$"
  list: { partitionValue: devices, attribute: id }   # list the id of the item where deviceId = "devices"
```

## 2.5 Limits and cache

```yaml
defaults:                 # defaults for all datasets
  limits: { maxRange: 7d }
  cacheTtlSeconds: 60
datasets:
  room_temp:
    ...
    limits:               # override per dataset
      maxRange: 31d
      maxItems: 50000
```

| Item | Default | Description |
|---|---|---|
| `limits.maxRange` | `31d` | Period that one query can cover (`90m` / `12h` / `31d`). 400 if exceeded |
| `limits.maxItems` | `50000` | Maximum number of items to read. Truncated when reached |
| `limits.maxPages` | `100` | Maximum number of pages to read |
| `limits.maxRcu` | `1000` | Maximum consumed RCU. Once exceeded, the next page is not read |
| `limits.maxKeys` | `20` | Number of keys that can be specified at once. 400 if exceeded |
| `cacheTtlSeconds` | `30` | Response cache duration in seconds (0 disables it) |

When a response is truncated, `meta.truncated` in the response is `true`, and `meta.truncatedBy` shows which limit was hit. For how to think about the limits, see [Operations and troubleshooting](06-operations.md#63-tuning-limits).

## 2.6 Settings reference

| Item | Default | Description |
|---|---|---|
| `description` | | Description (returned by `/datasets`) |
| `table` | Required | Table name |
| `index` | | GSI name |
| `partitionKey.name` | Required | Attribute name of the partition key |
| `partitionKey.template` | `{key}` | How to build the key. `{key}` is required. For date splits, `{yyyy-MM-dd}` / `{yyyy-MM}` |
| `partitionKey.bucket` | `none` | `daily` / `monthly` (match the date token in template) |
| `partitionKey.timezone` | `UTC` | Time zone of the date boundary (only when bucket is set) |
| `sortKey.name` | Required | Attribute name of the sort key |
| `sortKey.format` | Required | `epoch_s` / `epoch_ms` / `iso8601` |
| `sortKey.prefix` | `""` | Prefix of a composite sort key |
| `sortKey.timezone` | `UTC` | How to interpret ISO 8601 without an offset (only for `iso8601`) |
| `keys.pattern` | | Regular expression for accepted keys |
| `keys.values` | | List of accepted keys |
| `keys.list.partitionValue` / `keys.list.attribute` | | Registration item to read the key list from |
| `fields[].name` | Required | Attribute name. `a.b` for nested attributes. Do not list the sort key (it is returned automatically as the time column) |
| `fields[].alias` | | Column name (default is the attribute name with `.` replaced by `_`). Column names must be unique |
| `fields[].type` | `number` | `number` / `string` / `boolean` / `json` |
| `fields[].unit` | | Unit |
| `fields[].scale` | | Conversion by multiplication (only for `number`) |
| `limits.*` | Table above | Limits |
| `cacheTtlSeconds` | `30` | Response cache duration in seconds |

Dataset names start with a lowercase letter and contain only lowercase letters, digits, and `_` (up to 64 characters).

Specify time zones as `UTC`, an offset such as `+09:00`, or an IANA name such as `Asia/Tokyo`.

## 2.7 Configuration errors and deployment

If the configuration file has errors, `cdk synth` / `cdk deploy` stops and lists which item of which dataset is wrong. The messages are printed in Japanese, as shown below.

```
The configuration file has errors: config/datasets.yaml
  - datasets.room_temp.partitionKey.template: Include {yyyy-MM-dd} when bucket is daily
  - datasets.room_temp.keys: Specify pattern or values (to restrict the accepted keys; list is only for listing keys and does not restrict them)
```

After you fix type errors (a number where a string is expected, etc.), additional errors about combinations of items may appear.

After you change the settings, deploy again. The settings bundled with the Lambda function and the IAM permissions are updated.

```bash
pnpm cdk-deploy -c grafanaUser=true          # use the same -c as last time
pnpm check --dataset <dataset-name> --key <key>
```

To use a different configuration file, specify `-c config=path/to/datasets.yaml`.

## 2.8 Common mistakes

| Symptom | Cause |
|---|---|
| 500 `ValidationException: ... Condition parameter type does not match schema type` | `sortKey.format` does not match the table's type (`iso8601` for a numeric sort key, etc.). Or `prefix` is set when it should not be, or the other way around |
| 0 items returned | Because of a difference in `template` / `prefix` / `timezone`, it reads a partition or range that does not exist. Compare with the result of `pnpm init-dataset` |
| Value is `null` | Wrong attribute name, or a value that cannot be converted to `type` (`"abc"` for `number`, etc.) |
| 500 `ResourceNotFoundException` | Wrong table name or index name, or a different region |
| 404 `Dataset X is not defined` | You changed the settings but did not deploy again (the settings are bundled with the Lambda function) |

## Next

- [Connecting Grafana](03-grafana.md)
- [Panels and alerts](04-panels-and-alerts.md)
