# 4. Panels and alerts

English | [日本語](../ja/04-panels-and-alerts.md) ｜ [Docs index](../README.md)

This chapter explains how to create panels by calling the API (`GET /query`) with Infinity queries. The sample dashboard (`grafana/dashboards/room-temp.json`) has all the examples.

## 4.1 Basic query

In the panel editor, select dynamodb-timeseries-api (Infinity) as the data source and set the following.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/query-editor-dark.png">
  <img alt="Query settings (Type / Parser / Source / URL and URL Query Params)" src="../images/query-editor-light.png">
</picture>

| Item | Value | Note |
|---|---|---|
| Type | JSON | |
| Parser | JSONata | A parser that runs on the backend (JQ also works). Required for alerting (Frontend / UQL / GROQ do not work with alerts) |
| Source | URL | |
| URL | `query` | Appended to the Base URL of the data source |
| Method | GET | |
| URL Query Params | Table below | |
| Rows / Root | `rows` | |
| Columns | `time` (Time ( UNIX ms )), `key` (String), value columns (Number) | Set Rows / Root and Columns under "Parsing options & Result fields" |
| Format | Time Series | |

URL Query Params:

| Key | Value |
|---|---|
| `dataset` | Dataset name (e.g. `room_temp`) |
| `key` | `${key:csv}` (template variable. For fixed keys, `room-01,room-02`) |
| `from` | `${__from}` |
| `to` | `${__to}` |
| `interval` | `${__interval_ms}` (the API aggregates to match the display period) |
| `agg` | `avg` |
| `fields` | Columns to return (e.g. `temperature`. All columns if omitted) |

`rows` in the response is in long format: "1 row = time × key". When Format is Time Series, Infinity converts it into one series per key, and key becomes a label. To show only the room name in the legend, set the panel's "Standard options" → "Display name" to `${__field.labels.key}`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/parsing-options-dark.png">
  <img alt="Parsing options & Result fields (Rows / Root and Columns)" src="../images/parsing-options-light.png">
</picture>

## 4.2 Template variable (key drop-down)

Switch the dashboard to edit mode ("Edit") and add it with "+" under "Variables" in the right sidebar (Grafana 13; in earlier versions, "Dashboard settings" → "Variables" → "New variable").

| Item | Value |
|---|---|
| Variable type | Query |
| Data source | dynamodb-timeseries-api |
| Query type | Infinity |
| Type / Parser / Source | JSON / JSONata / URL |
| URL | `keys` |
| URL Query Params | `dataset` = dataset name |
| Columns | `key` (String) |
| Multi-value / Include All option | Enabled |

In queries, write `${key:csv}`. With multiple selections, the keys are passed comma-separated, like `room-01,room-02`. If the key list is empty, the dataset needs `keys.values` or `keys.list` ([Defining datasets](02-datasets.md#24-allowed-keys-and-key-list)).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/variable-dark.png">
  <img alt="Template variable settings" src="../images/variable-light.png">
</picture>

## 4.3 Common queries

| Purpose | Parameters | Panel |
|---|---|---|
| Trend (aggregated to match the display period) | `interval=${__interval_ms}&agg=avg` | Time series |
| Raw data | No `interval` | Time series / Table |
| Latest value | `latest=1` | Stat / Gauge |
| Daily max / min | `interval=1d&agg=max` (`agg=min` in another query), `tz=Asia/Tokyo` | Time series (Bars) / Bar chart |
| Count | `interval=1h&agg=count` | Time series (Bars) |
| Multiple keys side by side as columns | `format=wide` (column names are `key_column`) | Table |
| API information | Set Rows / Root to `meta` and Format to Table | Table |

### (1) Aggregation (interval / agg)

- `interval` is `$__interval_ms` (milliseconds) or the form `30s` / `5m` / `1h` / `1d`
- `agg` is `avg` (default) / `min` / `max` / `sum` / `count` / `last`
- Missing values (null) are excluded from aggregation. For non-numeric columns, `avg` and similar return the last value in the bucket, and `count` returns the count
- Bucket boundaries follow the wall clock of the time zone. The default is the dataset's time zone (`partitionKey.timezone` for keys split by date, otherwise `sortKey.timezone`). You can override it, e.g. `tz=Asia/Tokyo`
- Aggregation does not change the number of items read from DynamoDB or the consumed RCU. It reduces the response size and the load on Grafana

### (2) Latest value (latest=1)

Returns the latest single item in the period for each key. It reads newest first and stops when it finds one item in the range, so a longer period barely increases the amount read. It suits Stat panels and alerts. It cannot be specified together with `interval`.

### (3) API information (meta)

Set Rows / Root to `meta` and Format to Table to show information about the same query.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/meta-dark.png">
  <img alt="API information (meta) panel" src="../images/meta-light.png">
</picture>

| Column | Content |
|---|---|
| `points` | Number of points returned |
| `items` | Number of items read from DynamoDB |
| `pages` | Number of pages read |
| `consumedRcu` | Consumed RCU |
| `truncated` / `truncatedBy` | Whether a limit truncated the result, and which limit |
| `cache` | Cache hit / miss |

## 4.4 Alerts

Alerts are evaluated in the Grafana backend. So they differ from dashboards in the following ways.

| Item | Dashboard | Alert |
|---|---|---|
| `${__from}` / `${__to}` | Available | Available (replaced by the Infinity backend) |
| `${__interval_ms}` | Available | Not available (not replaced) |
| Template variables (`${key:csv}`) | Available | Not available |
| Parser | Any | Backend group only (JSONata / JQ) |

In alert queries, write the `key` values directly, and use `latest=1` or a fixed `interval` (`5m`, etc.). If a variable that was not replaced reaches the API, it returns 400 with "a Grafana variable was not replaced".

The sample alert rule (`grafana/provisioning/alerting/room-temp.yaml`) fires when the latest temperature stays above 29°C for 5 minutes.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/alert-rule-dark.png">
  <img alt="Sample alert rule" src="../images/alert-rule-light.png">
</picture>

| Step | Setting |
|---|---|
| A (query) | `dataset=room_temp`, `key=room-01,room-02,room-03`, `from=${__from}`, `to=${__to}`, `latest=1`, `fields=temperature`, Format: Time Series |
| B (Reduce) | Last of A |
| C (Threshold) | B is above 29 |
| Evaluation | Every 1 minute, fires after 5 minutes |

Because there is one series per key, the alert is also evaluated per room (multi-dimensional alert). In notification text, you can use the room name with `{{ $labels.key }}`.

## 4.5 If Grafana only shows "400 Bad Request"

When the API returns a response of 400 or higher, Infinity does not show the response body (the reason). Check the reason in one of these ways.

- Run `pnpm check --dataset <name> --key <key>` with the same conditions, or call the API directly
- Look at `error` in CloudWatch Logs (`/aws/lambda/dynamodb-timeseries-api`) ([Operations and troubleshooting](06-operations.md#61-logs))

## Next

- [Deployment options](05-deployment-options.md)
- [API reference](07-api-reference.md)
