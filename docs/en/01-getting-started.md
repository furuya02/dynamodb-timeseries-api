# 1. Getting started

English | [日本語](../ja/01-getting-started.md) ｜ [Docs index](../README.md)

This chapter walks through the steps from deployment to viewing a dashboard in Grafana, using a sample table and simulated sensor data. It takes about 15 minutes. To try it without AWS, see [Try without AWS](#try-without-aws).

## 1.1 Requirements

| Item | Tested version | Purpose |
|---|---|---|
| Node.js | 22.23.4 (22 or later) | Runs CDK and the scripts. The Lambda runtime is nodejs24.x |
| pnpm | 10.24.0 (10 or later) | Installs dependencies and runs commands (npm / npx are not used) |
| Docker | 29.5.3 | Local Grafana and DynamoDB Local |
| AWS CLI | v2 | Creating access keys, etc. |
| AWS account | | Deployment target |

To deploy, you need permissions to create CloudFormation, IAM, Lambda, API Gateway, DynamoDB, and CloudWatch Logs resources.

If you do not have pnpm, you can install it with Corepack, which comes with Node.js.

```bash
corepack enable
corepack prepare pnpm@10.24.0 --activate
```

## 1.2 Clone and install dependencies

```bash
git clone https://github.com/furuya02/dynamodb-timeseries-api.git
cd dynamodb-timeseries-api
pnpm install
```

## 1.3 AWS credentials and region

The same credentials as the AWS CLI are used (environment variables, a profile in `~/.aws/config`, IAM Identity Center, etc.).

```bash
aws sts get-caller-identity   # check which account you are using
export AWS_REGION=ap-northeast-1
```

- The CDK deployment region is the profile's region (ap-northeast-1 if not set)
- The scripts (`pnpm seed`, etc.) use `AWS_REGION` (ap-northeast-1 if not set). When you deploy to a region other than ap-northeast-1, set `AWS_REGION` to the same region

If this is the first time you use CDK in this account and region, you need to bootstrap (only once).

```bash
pnpm --dir cdk exec cdk bootstrap
```

## 1.4 Deploy

Create the sample table (`-c sample=true`) and an IAM user for Grafana (`-c grafanaUser=true`) together.

```bash
pnpm cdk-deploy -c sample=true -c grafanaUser=true
```

It finishes in about 2 minutes and prints the outputs.

```
Outputs:
DynamodbTimeseriesApiStack.CreateAccessKeyCommand = aws iam create-access-key --user-name dynamodb-timeseries-api-grafana
DynamodbTimeseriesApiStack.Endpoint = https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/v1/
DynamodbTimeseriesApiStack.GrafanaPolicyArn = arn:aws:iam::123456789012:policy/dynamodb-timeseries-api-invoke
DynamodbTimeseriesApiStack.GrafanaUserName = dynamodb-timeseries-api-grafana
DynamodbTimeseriesApiStack.Region = ap-northeast-1
```

| Output | Meaning |
|---|---|
| Endpoint | Base URL of the API. Set it in the Grafana data source |
| Region | Region to set in the Grafana AWS authentication |
| GrafanaPolicyArn | Managed policy that only allows calling the API |
| GrafanaUserName / CreateAccessKeyCommand | IAM user for Grafana, and the command to create its access key |

Resources created: a Lambda function (`dynamodb-timeseries-api`), a REST API (stage `v1`), a CloudWatch Logs log group (7-day retention), IAM (the Lambda execution role, a managed policy and a user for Grafana), and a DynamoDB table (`dynamodb-timeseries-api-sample`, on-demand billing).

## 1.5 Load sample data

```bash
pnpm seed
```

This writes temperature and humidity for 3 rooms (room-01 to 03) × 7 days × every 1 minute (about 30,000 items). It takes about 30 seconds.
To look like real sensors, the data includes day-to-day weather changes, air conditioning on weekdays 9:00–18:00, different daily ranges per room (room-02 is by a window and swings more, room-03 is inside and swings less), occasional short heat spikes (+5°C for 40 minutes), and short gaps (30–90 minutes). Every run produces the same data. You can change the period and the number of rooms with `--days` and `--rooms`, and the interval (minutes) with `--step`.

## 1.6 Check the connection

Before configuring Grafana, check that the API responds.

```bash
pnpm check
```

The script prints its messages in Japanese, as shown below.

```
Endpoint: https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/v1/
Auth: IAM (SigV4, service execute-api, ap-northeast-1)

OK GET /datasets（161ms）: room_temp
OK GET /keys?dataset=room_temp（114ms）: room-01, room-02, room-03
OK GET /query last 1 hour, 5-minute average (73ms): 12 points, items read 60, consumed RCU 0.5
OK GET /query latest value (101ms): 2026-11-04T20:59:00.000Z {"time":...,"key":"room-01","temperature":20.3,"humidity":59.2}
```

`pnpm check` reads the endpoint and the authentication method from the CloudFormation outputs, and calls the API with SigV4 signing using your own credentials. If it shows NG, follow the cause it prints, or see [Operations and troubleshooting](06-operations.md).

## 1.7 View in Grafana

Start Grafana OSS 13.3.0 and Infinity 4.1.5 with local Docker.

### (1) Create an access key

```bash
aws iam create-access-key --user-name dynamodb-timeseries-api-grafana
```

Put the displayed `AccessKeyId` and `SecretAccessKey` into environment variables. This key only has permission to call the API. The key is not managed by CloudFormation, so delete it by hand when you clean up.

```bash
export TSAPI_AWS_ACCESS_KEY_ID=AKIA...
export TSAPI_AWS_SECRET_ACCESS_KEY=...
```

### (2) Create the data source settings and start Grafana

```bash
pnpm grafana-config
pnpm grafana-up
```

`pnpm grafana-config` creates `grafana/provisioning/generated/datasources/dynamodb-timeseries-api.yaml` from the deployment outputs. The access key values are not written to the file. Grafana reads them from environment variables when it starts.

With Docker on Linux, start it with the following command instead (not needed with Docker Desktop / Rancher Desktop).

```bash
docker compose -f grafana/docker-compose.yml -f grafana/docker-compose.linux.yml up -d
```

### (3) Open the dashboard

Open http://localhost:3000/ and select "Dashboards" → "dynamodb-timeseries-api" → "Room temperature and humidity (dynamodb-timeseries-api sample)".

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/dashboard-dark.png">
  <img alt="Sample dashboard" src="../images/dashboard-light.png">
</picture>

- You can view it without logging in (anonymous access in Grafana 13 is viewer only)
- To edit, log in as admin / admin from "Sign in" at the top right
- Select rooms with "Room" at the top (multiple selection)

| Panel | Content |
|---|---|
| Temperature / Humidity (average per interval) | Trend aggregated by the API to match the display period |
| Latest temperature / Latest humidity | Latest value per room (gauge / bar gauge) |
| Daily max temperature (JST) | Daily max temperature split at 00:00 JST (bar chart) |
| API response (meta) | Items read, consumed RCU, truncation, cache |

A sample alert rule (fires when the latest temperature stays above 29°C for 5 minutes) is also loaded into "Alerting" → "Alert rules".

## 1.8 Cost estimate

- The steps above (deployment, loading about 30,000 items, a few hundred queries) cost less than $0.1 in ap-northeast-1 (as of November 2026)
- Leaving it deployed costs almost nothing. Lambda and DynamoDB are on-demand, and the REST API is billed per request
- If you leave a Grafana dashboard open, the API is called on every auto refresh (every minute)

## 1.9 Clean up

When you are done, delete everything with the steps in [Operations and troubleshooting](06-operations.md#65-clean-up). You must delete the access key created outside CDK first. Otherwise the IAM user cannot be deleted.

## Try without AWS

Use DynamoDB Local and `pnpm local-api`, which runs the API locally. No AWS credentials are needed.

```bash
pnpm install
pnpm grafana-config --local
docker compose -f grafana/docker-compose.yml --profile local up -d   # Grafana and DynamoDB Local (port 8000)

export AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000 AWS_REGION=ap-northeast-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local
pnpm seed --create      # create the table and load sample data
pnpm local-api          # port 13000. Keep it running in another terminal
```

You can view the dashboard at http://localhost:3000/. Run `pnpm check --endpoint http://localhost:13000` in another terminal to also check the API responses.

- DynamoDB Local keeps data in memory, so run `pnpm seed --create` again after you recreate the container
- When you are done, stop it with `docker compose -f grafana/docker-compose.yml --profile local down`

## Next

- [Defining datasets](02-datasets.md): use your own table
- [Connecting Grafana](03-grafana.md): connect from Grafana Cloud, Amazon Managed Grafana, or an existing Grafana
