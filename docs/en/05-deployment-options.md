# 5. Deployment options

English | [日本語](../ja/05-deployment-options.md) ｜ [Docs index](../README.md)

With `pnpm cdk-deploy -c name=value`, you can choose the exposure type and the authentication method. Invalid values and combinations are listed together at synth time, and the deployment stops.

## 5.1 Options

| Name | Default | Values |
|---|---|---|
| `config` | `config/datasets.yaml` | Path of the configuration file |
| `exposure` | `restPublic` | `restPublic` / `functionUrl` / `restPrivate` |
| `auth` | `iam` | `iam` / `apiKey` |
| `vpcEndpointId` | | ID starting with `vpce-` (required for `restPrivate`) |
| `grafanaUser` | `false` | `true` creates an IAM user for Grafana (when `auth=iam`) |
| `grafanaRoleTrust` | | ARN that can assume the role for Grafana (when `auth=iam`) |
| `logRetentionDays` | `7` | CloudWatch Logs retention in days (1 / 3 / 5 / 7 / 14 / 30 / 60 / 90 / 120 / 150 / 180 / 365 / 400 / 545 / 731 / 1096 / 1827 / 2192 / 2557 / 2922 / 3288 / 3653) |
| `throttleRate` / `throttleBurst` | `10` / `20` | Usage plan rate (per second) and burst (when `auth=apiKey`) |
| `sample` | `false` | `true` creates the sample table |
| `cold` / `coldIngest` / `coldScanLimitGb` / `coldRemovalPolicy` / `bucket_suffix` | | Cold storage ([Cold storage](09-cold-storage.md#91-enabling-it)) |

`pnpm cdk-destroy` deletes the whole stack. When you delete, it is safest to pass the same `-c` as for the deployment (the examples in these docs do so).

## 5.2 Exposure type (exposure)

| Value | Entry point | Suited for | Cost |
|---|---|---|---|
| `restPublic` (default) | API Gateway REST API (REGIONAL). Stage `v1` | Most cases | REST API request charges |
| `functionUrl` | Lambda function URL (IAM authentication) | When API Gateway features (API keys, usage plans) are not needed | The function URL itself is free (Lambda charges only) |
| `restPrivate` | Private REST API. Can only be called from the specified VPC endpoint | When Grafana is in a VPC and you do not want to expose the API to the internet | REST API request charges (VPC endpoint charged separately) |

### (1) restPrivate

No VPC or VPC endpoint is created. Specify the ID of an existing interface VPC endpoint for execute-api.

```bash
pnpm cdk-deploy -c exposure=restPrivate -c vpcEndpointId=vpce-0123456789abcdef0
```

The resource policy denies calls from anything other than the specified VPC endpoint. The allowed principal is this account for `auth=iam`, and anyone (restricted by the key) for `auth=apiKey`.

restPrivate has been checked in the synth output, but calls from an actual VPC have not been tested.

## 5.3 Authentication method (auth)

| Value | How it works | Available exposure types |
|---|---|---|
| `iam` (default) | SigV4 signing. Grafana gets only the permission to call the API | All |
| `apiKey` | `x-api-key` header. Rate limited by a usage plan | `restPublic` / `restPrivate` |

### (1) Permissions for IAM authentication

With `auth=iam`, a managed policy `dynamodb-timeseries-api-invoke` is created that only allows calling the API.

| Exposure type | Policy content |
|---|---|
| REST API | `execute-api:Invoke` (GET on stage `v1` only) |
| Function URL | `lambda:InvokeFunctionUrl` (condition `lambda:FunctionUrlAuthType = AWS_IAM`) and `lambda:InvokeFunction` limited to calls via the function URL (condition `lambda:InvokedViaFunctionUrl = true`). Same as AWS CDK's `grantInvokeUrl` |

There are 3 ways to give this policy to Grafana.

| Method | Option | When to use |
|---|---|---|
| IAM user | `-c grafanaUser=true` | Local, Grafana Cloud, Amazon Managed Grafana (access key) |
| Role | `-c grafanaRoleTrust=<ARN>` | Assume Role from Grafana in another account, etc. |
| Attach to an existing role | Output `GrafanaPolicyArn` | EC2 instance roles, etc. |

CDK does not create the access key for the IAM user (so that the key does not end up stored outside CloudFormation in a form that is hard to manage). Create it with the output `CreateAccessKeyCommand`, and delete it when you no longer use it.

### (2) API key

```bash
pnpm cdk-deploy -c auth=apiKey -c throttleRate=10 -c throttleBurst=20
```

The key value is not shown in the CloudFormation outputs. Get it with the command in the output `GetApiKeyCommand`. `pnpm check` and `pnpm grafana-config` use this key automatically.

The usage plan burst is not a strict limit. When 60 requests were sent at the same time, only 1 got 429 (settings: rate 10 / burst 20).

## 5.4 Notes on changing the configuration

- If you change from `auth=iam` to `auth=apiKey`, the IAM user for Grafana is deleted. If an access key created outside CDK still exists, the deletion fails, so delete the key first
- If you change `exposure`, the endpoint (URL) changes. Update the Base URL of the Grafana data source (you can recreate it with `pnpm grafana-config`)
- The policy is to keep logical IDs unchanged in future versions. Deploying a new version to an existing environment does not recreate the log group or the API

## 5.5 Resources created and their names

| Resource | Name | Condition |
|---|---|---|
| Lambda function | `dynamodb-timeseries-api` (Node.js 24, arm64, 512MB, 29 seconds) | Always |
| Log group | `/aws/lambda/dynamodb-timeseries-api` | Always |
| REST API | `dynamodb-timeseries-api` (stage `v1`) | `restPublic` / `restPrivate` |
| Function URL | | `functionUrl` |
| Managed policy | `dynamodb-timeseries-api-invoke` | `auth=iam` |
| IAM user | `dynamodb-timeseries-api-grafana` | `grafanaUser=true` |
| IAM role | `dynamodb-timeseries-api-grafana` | `grafanaRoleTrust` |
| API key / usage plan | `dynamodb-timeseries-api-grafana` / `dynamodb-timeseries-api` | `auth=apiKey` |
| DynamoDB table | `dynamodb-timeseries-api-sample` | `sample=true` |
| S3 bucket, Glue, Athena workgroup, ingestion Lambda / Firehose | [Cold storage](09-cold-storage.md#92-resources) | `cold=true` |

The names must be unique within the account and region. The current version does not support deploying a second copy to the same account and region.

The Lambda execution role only gets `dynamodb:Query` on the tables and indexes written in `datasets.yaml`.

## Next

- [Operations and troubleshooting](06-operations.md)
