# 6. Operations and troubleshooting

English | [日本語](../ja/06-operations.md) ｜ [Docs index](../README.md)

## 6.1 Logs

The Lambda function writes one line of JSON per request to the log group `/aws/lambda/dynamodb-timeseries-api` (retention is `-c logRetentionDays`, default 7 days).

```json
{"requestId":"e68dd40f-...","type":"query","status":200,"dataset":"room_temp","keys":3,"rangeMs":86399999,"interval":300000,"agg":"avg","format":"long","cache":"miss","queries":3,"pages":3,"items":4320,"consumedRcu":25.5,"points":864,"durationMs":254}
```

| Field | Content |
|---|---|
| `requestId` | Lambda request ID (can be matched with the REPORT line in the same log group) |
| `type` | `query` / `keys` / `datasets` / `unknown` |
| `status` | HTTP status |
| `error` | Reason for 400 / 404 / 500 (not shown in Grafana) |
| `cache` | `hit` / `miss` |
| `queries` / `pages` / `items` / `consumedRcu` | DynamoDB reads (not written on a cache hit) |
| `truncatedBy` | The limit that truncated the result |
| `points` / `durationMs` | Number of points returned and duration |

### (1) CloudWatch Logs Insights examples

```
# requests, consumed RCU, and average duration per dataset
filter type = "query"
| stats count(*) as requests, sum(consumedRcu) as rcu, avg(durationMs) as avgMs by dataset, cache

# list of errors
filter status >= 400
| fields @timestamp, status, dataset, error
| sort @timestamp desc

# requests truncated by a limit
filter ispresent(truncatedBy)
| stats count(*) by dataset, truncatedBy
```

Use `stats` aliases that differ from the original field names. With the same name, such as `sum(items) as items`, the column sometimes did not appear in the results.

## 6.2 Cost estimate

| Item | How it is billed |
|---|---|
| DynamoDB reads | Consumed RCU (read request units for on-demand). Aggregation does not reduce it. You can reduce it with `latest=1` and shorter periods |
| Lambda | Number of requests and duration (512MB, arm64) |
| API Gateway (REST) | Number of requests (function URLs are free) |
| CloudWatch Logs | Ingestion and storage |

Measured (3 rooms × 7 days, every 1 minute, ap-northeast-1):

| Query | Items read | Consumed RCU | Response time | Response size |
|---|---|---|---|---|
| 1 key, 1 hour, raw data | 57 | 0.5 | 219ms | 4KB |
| 3 keys, 24 hours, 5-minute average | 4,320 | 25.5 | 254ms | 64KB |
| 3 keys, 7 days, raw data | 30,231 | 177 | 1,226ms | 2,173KB |
| 3 keys, 7 days, 1-hour average | 30,240 | 177 | 1,016ms | 43KB |
| 3 keys, 7 days, latest value | 3 | 1.5 | 69ms | 0KB |

Dashboard auto refresh calls the API (number of panels × number of refreshes) times. Because of the response cache (default 30 seconds) and the rounding of times during aggregation, queries for the same buckets are served from the cache.

## 6.3 Tuning limits

| Limit | When exceeded | How to tune |
|---|---|---|
| `maxRange` | 400 | Match the longest period that can be selected in the dashboard |
| `maxKeys` | 400 | Match the number of keys that can be selected in the template variable |
| `maxItems` / `maxPages` / `maxRcu` | Truncated (`truncated: true`) | Estimate from period × number of keys × items per key |
| Response size (5.5MB) | 400 "The response is too large" | Aggregate with `interval`, shorten the period, or reduce columns with `fields` |

- `maxRcu` works as "do not read the next page once exceeded". It can go over by up to one page (max 1MB, about 128 RCU)
- Multiple keys and dates are read in parallel, so `maxItems` can be exceeded by the pages read at the same time (up to 8 pages)
- The Lambda response limit is 6MB. If it is exceeded, API Gateway returns 502 and the reason is unknown, so responses over 5.5MB return 400 with a reason

## 6.4 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Grafana only shows `status code : 400 Bad Request` | Infinity does not show the body of 4xx responses. Try the same conditions with `pnpm check`, or look at `error` in the logs |
| `a Grafana variable was not replaced` | A query for an alert (or anything other than a dashboard) uses template variables or `$__interval_ms`. Write the values directly |
| 403 in the data source test | IAM: check that the signing key has the `dynamodb-timeseries-api-invoke` permissions, and that Service is `execute-api` (`lambda` for a function URL). API key: check that the key is correct |
| 403 and 200 alternate right after changing IAM permissions | IAM changes can take a few minutes to take effect. Wait a little and check again |
| 500 `ValidationException` | The key names or time format in `datasets.yaml` differ from the actual table ([Defining datasets](02-datasets.md#28-common-mistakes)) |
| 500 `ResourceNotFoundException` | Wrong table name or index name, or a different region |
| 404 `Dataset X is not defined` | You changed the settings but did not deploy again |
| `The response is too large` | See "Tuning limits" above |
| `meta.truncated: true` | See "Tuning limits" above |
| Panel is empty (no error) | No data in the period, wrong `key`, or Columns names differ from the column names in the response |
| Local Grafana cannot reach `pnpm local-api` | On Linux, add `docker-compose.linux.yml`. With Docker Desktop / Rancher Desktop, do not add it (adding it makes the API unreachable) |
| `pnpm check` shows `The outputs of stack ... have no Endpoint` | `AWS_REGION` differs from the deployed region, or the stack name differs (`--stack` / `--region`) |

## 6.5 Clean up

```bash
pnpm grafana-down

# delete the access key created outside CDK first (if it remains, the IAM user cannot be deleted)
aws iam list-access-keys --user-name dynamodb-timeseries-api-grafana
aws iam delete-access-key --user-name dynamodb-timeseries-api-grafana --access-key-id AKIA...

# delete with the same -c as the deployment
pnpm cdk-destroy -c sample=true -c grafanaUser=true
```

- Deleted: Lambda, REST API / function URL, log group, IAM (policy, user, role), API key, usage plan, sample table (its data is deleted too)
- Not deleted: your own tables (CDK only refers to them by name), and deployment assets left in the CDK bootstrap S3 bucket

## 6.6 Update to a new version

```bash
git pull
pnpm install
pnpm cdk-deploy <same -c as last time>
```

For the changes, see [CHANGELOG.md](../../CHANGELOG.md).

## Next

- [API reference](07-api-reference.md)
