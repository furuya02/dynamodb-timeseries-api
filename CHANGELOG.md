# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Cold storage (hot + cold): data older than `cold.hotRetention` is read from S3 + Athena (1-minute rollups as Parquet, partition projection) and merged with DynamoDB data into one series in a single query
  - `datasets.yaml`: `cold` (`type`, `hotRetention`, `maxRange`)
  - Deploy options: `cold`, `coldIngest` (`scheduled` / `stream`), `coldScanLimitGb`, `coldRemovalPolicy`, `bucket_suffix`
  - Scheduled ingestion (EventBridge Scheduler → Lambda, previous day, idempotent) and stream ingestion (DynamoDB Streams → Lambda → Firehose)
  - `meta.cold` in `/query` responses (range, rows, bytes scanned, engine time)
  - Scripts: `pnpm cold-backfill`, `pnpm seed --cold-days`
  - TTL attribute `expiresAt` on the sample table
- Documentation: chapter 9, Cold storage (English and Japanese)
- Documentation images: architecture diagrams (draw.io sources included), Grafana screenshots in light and dark themes, Mermaid flow charts, and a social preview image
- `pnpm docs-screenshots` (Playwright) to retake the Grafana screenshots
- Sample dashboard: `Cold bytes` column (`meta.cold.bytesScanned`) in the meta table

### Changed

- Project and resource names are now `dynamodb-timeseries-api` (stack `DynamodbTimeseriesApiStack`)
- Aggregation is computed from mergeable partial aggregates (results are unchanged)
- The sample dashboard and alert rule are in English
- All user-facing messages are in English: API errors, configuration and deploy option validation, CLI output (`pnpm seed`, `check`, `init-dataset`, `grafana-config`, `local-api`, `cold-backfill`), CloudFormation output descriptions, and the sample `datasets.yaml`

### Fixed

- Unit tests failed on a fresh clone because `datasets.generated.json` did not exist yet

## [0.1.0] - Unreleased

First release.

### Added

- API (`GET /query`, `/datasets`, `/keys`) on AWS Lambda (Node.js 24, arm64), deployed with the AWS CDK
- One configuration file, `config/datasets.yaml`, validated at `cdk synth` time
  - Prefixed partition keys (`template`), composite sort keys (`prefix`), date-split partition keys (`bucket`, `timezone`), GSIs (`index`)
  - Time formats: `epoch_s`, `epoch_ms`, `iso8601` (with time zone handling)
  - Allowed keys (`keys.pattern`, `keys.values`) and key lists for Grafana variables (`keys.list`)
  - Attribute allow list, type conversion, aliases, units, scaling, nested attributes
  - Limits (`maxRange`, `maxItems`, `maxPages`, `maxRcu`, `maxKeys`) and response cache (`cacheTtlSeconds`)
- Query parameters: `interval` / `agg` (downsampling), `latest`, `format` (long / wide), `tz`, `fields`
- Guardrails: truncation with `meta.truncatedBy`, a response size limit (5.5 MB) with an actionable error, a clear error when Grafana variables are not replaced (alerting)
- Structured JSON logs (one line per request, with the Lambda request ID)
- Deploy options: `exposure` (`restPublic`, `functionUrl`, `restPrivate`), `auth` (`iam`, `apiKey`), `grafanaUser`, `grafanaRoleTrust`, `logRetentionDays`, `throttleRate`, `throttleBurst`, `sample`
- Scripts: `pnpm seed`, `pnpm init-dataset`, `pnpm check`, `pnpm grafana-config`, `pnpm local-api`
- Sample data with day-to-day weather, weekday air conditioning, per-room differences, heat spikes, and gaps
- Local Grafana setup (Grafana OSS 13.3.0 + Infinity 4.1.5) with a sample dashboard (time series, gauge, bar gauge, bar chart, table) and alert rule
- Documentation in English and Japanese
- Tests (Vitest): unit, CDK template, and DynamoDB Local integration tests; CI on GitHub Actions
