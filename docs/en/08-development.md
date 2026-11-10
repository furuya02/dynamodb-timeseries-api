# 8. Development

English | [日本語](../ja/08-development.md) ｜ [Docs index](../README.md)

This chapter covers the code structure, tests, CI, and the release steps. For how to propose changes, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## 8.1 Repository structure

```
.
├── config/datasets.yaml        # dataset definitions (written by users)
├── cdk/                        # pnpm workspace package (CDK app and Lambda)
│   ├── bin/                    # CDK app entry point (validates settings and deployment options)
│   ├── lib/                    # stack, building blocks, configuration schema (zod)
│   ├── lambda/api/             # Lambda (API)
│   ├── lambda/ingest/          # Lambda (cold storage ingestion)
│   └── test/                   # unit / cdk / integration
├── scripts/                    # pnpm workspace package (seed, init-dataset, check, etc.)
│   ├── lib/                    # pure functions for inference, generation, etc.
│   └── test/
├── grafana/                    # docker-compose, provisioning, sample dashboard
├── docs/                       # documentation (ja / en)
└── .github/                    # CI, Dependabot, Issue / PR templates
```

## 8.2 Lambda (cdk/lambda/api)

| File | Role |
|---|---|
| `index.ts` | Lambda entry point. Accepts both REST API (payload 1.0) and function URL (2.0) events |
| `app.ts` | `createApi()`. Path routing, cache, structured logs. Receives its dependencies (settings, DynamoDB client, cache, logger, clock) |
| `request.ts` | Validation of `/query` parameters |
| `key-condition.ts` | Partition key values, sort key ranges, reading times |
| `reader.ts` | Query API paging, parallel execution, truncation by limits |
| `transform.ts` | Column selection, ProjectionExpression, type conversion |
| `aggregate.ts` | Aggregation and output format (long / wide) |
| `response.ts` | Building the response and checking its size |
| `catalog.ts` | `/datasets` and `/keys` |
| `cache.ts` | Response cache (TTL, byte limit) |
| `time.ts` | Time zone calculations (no external library) |
| `types.ts` / `errors.ts` / `rows.ts` | Shared types, errors, row ordering |
| `split.ts` | Splits the range into hot and cold (boundary = now − hotRetention) |
| `cold/sql.ts` / `cold/athena.ts` / `cold/reader.ts` | Cold table columns and SQL, Athena execution (stopped on timeout), conversion of results to partial aggregates |

`aggregate.ts` merges partial aggregates (count, sum, min, max, last value) before computing the requested `agg`. This is what lets DynamoDB rows and pre-aggregated cold rows be combined in the same bucket.

### Cold storage ingestion (cdk/lambda/ingest)

| File | Role |
|---|---|
| `rollup.ts` | Rows → 1-minute rollups, Parquet output (hyparquet-writer) |
| `day.ts` | Ingests one UTC day (Query → rollup → S3, replacing the date folder). Also used by `pnpm cold-backfill` and `pnpm seed --cold-days` |
| `scheduled.ts` | Entry point of the scheduled ingestion Lambda |
| `stream-match.ts` / `stream.ts` | Routing stream items to datasets and keys, and the entry point of the stream Lambda |

Design principles:

- Only the DynamoDB Query API is used (no Scan). Flexibility comes from `datasets.yaml`
- Settings are validated at synth time and bundled with the Lambda function as `datasets.generated.json` (environment variables are not used because of their 4KB limit)
- The DynamoDB client is received through the `QueryClient` interface and replaced with a fake in tests
- The only external library of the API is the AWS SDK. The AWS SDK is not bundled; the one included in the Lambda runtime is used (only the ingestion Lambda bundles hyparquet-writer to write Parquet)

## 8.3 CDK (cdk/lib)

| File | Role |
|---|---|
| `config.ts` | `datasets.yaml` schema (zod), applying defaults, showing errors |
| `options.ts` | Validation of deployment options (`-c`) |
| `dynamodb-timeseries-api-stack.ts` | Stack |
| `api-function.ts` / `endpoint.ts` / `grafana-access.ts` / `sample-table.ts` | Lambda, entry point for each exposure type, IAM for Grafana, sample table |
| `cold-store.ts` / `cold-ingest.ts` / `cold-stream.ts` | Cold storage (S3, Glue, Athena, API permissions), scheduled ingestion, stream ingestion (Firehose) |

Each building block creates resources directly with the stack as scope, not as a child construct. This keeps the logical IDs unchanged (if they change, the log group and the API are recreated in existing environments). For changes to the resource structure, write in the CHANGELOG whether resources are replaced.

## 8.4 Development setup

```bash
pnpm install
pnpm lint          # Biome (lint and format check)
pnpm format        # format with Biome
pnpm typecheck     # TypeScript (cdk and scripts)
```

## 8.5 Tests

| Command | Content | Requirements |
|---|---|---|
| `pnpm test` | Unit tests (cdk and scripts) and CDK template tests | None |
| `pnpm test:integration` | Integration tests with DynamoDB Local | DynamoDB Local |
| `pnpm coverage` | Coverage (cdk unit + integration) | DynamoDB Local |

```bash
docker run -d --rm -p 8000:8000 amazon/dynamodb-local:3.3.2 -jar DynamoDBLocal.jar -inMemory
pnpm test:integration
```

| Location | Content |
|---|---|
| `cdk/test/unit` | Validation of the Lambda function and the settings. DynamoDB is a fake client (`fakeClient`) |
| `cdk/test/cdk` | Validates the template with `aws-cdk-lib/assertions` (combinations of exposure type and authentication, scope of IAM permissions) |
| `cdk/test/integration` | Creates tables in DynamoDB Local (`global-setup.ts`) and checks behavior through `createApi()` |
| `scripts/test` | Inference, data source settings generation, signed calls, sample data generation |

Testing principles:

- Add unit tests for new settings and parameters. If they depend on DynamoDB behavior, also add integration tests
- CDK tests save and restore `datasets.generated.json`, which is rewritten on every synth, before and after the tests
- The DynamoDB Local endpoint for integration tests is `AWS_ENDPOINT_URL_DYNAMODB` (default `http://localhost:8000`)

## 8.6 Run the API locally

```bash
docker compose -f grafana/docker-compose.yml --profile local up -d
export AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000 AWS_REGION=ap-northeast-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local
pnpm seed --create
pnpm local-api                                   # http://localhost:13000/
pnpm check --endpoint http://localhost:13000
```

`pnpm local-api` runs the same `createApi()` as the Lambda function in an HTTP server without authentication.

## 8.7 CI

`.github/workflows/ci.yml` runs the following on push (main) and on PRs.

| Job | Content |
|---|---|
| check (Node.js 22 / 24) | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm cdk-synth` (no AWS credentials) |
| integration | `pnpm test:integration` with DynamoDB Local (services) |

Dependabot proposes updates once a week for npm dependencies (AWS SDK, AWS CDK, and development tools grouped together), GitHub Actions, and docker-compose images.

## 8.8 Release

1. Change Unreleased in `CHANGELOG.md` to a heading with the version and date
2. Bump `version` in the root and each package's `package.json` ([Semantic Versioning](https://semver.org/). Changes that break configuration file compatibility are major)
3. Merge into main, add a tag such as `v0.2.0`, and create a GitHub release

## 8.9 Test on AWS

If a change affects AWS behavior (IAM, exposure type, logs, etc.), deploy it to your own account and test it.

```bash
pnpm cdk-deploy -c sample=true -c grafanaUser=true
pnpm seed && pnpm check
# clean up after testing (delete the access key first)
pnpm cdk-destroy -c sample=true -c grafanaUser=true
```

IAM changes can take a few minutes to take effect. If you switch the permissions of the same principal while testing, the results are inconsistent, so when you compare permission combinations, use a separate IAM user for each combination.

## 8.10 Images in the documentation

Images are in `docs/images/`.

| Kind | Files | How to update |
|---|---|---|
| Architecture diagrams | `architecture` / `exposure` / `auth` / `hot-cold` (`.drawio` and `.png`) | Edit the `.drawio` file in draw.io and export it as PNG (`drawio -x -f png -s 2 -b 16 -o <name>.png <name>.drawio`) |
| Grafana screenshots | `<name>-light.png` / `<name>-dark.png` | `pnpm docs-screenshots` (below) |
| Flow charts | Mermaid in the documentation | Edit the Markdown directly (GitHub renders it) |
| Social preview | `social-preview.png` (1280×640) | Upload it in the repository's Settings → Social preview on GitHub |

Grafana screenshots are taken in both light and dark themes, and `<picture>` shows the one that matches the reader's theme.

```bash
pnpm --dir scripts exec playwright install chromium   # first time only
pnpm grafana-config && pnpm grafana-up                # start Grafana with data
pnpm docs-screenshots                                 # overwrite docs/images/<name>-light.png / -dark.png
pnpm docs-screenshots --cold                          # also cold storage screens (needs cold=true and pnpm seed --cold-days 30)
pnpm docs-screenshots --only dashboard,meta           # retake only some
```

The screens (URL, viewport height, actions before the shot) are defined in `shots` in `scripts/docs-screenshots.ts`. Update it when a Grafana upgrade changes the UI.
