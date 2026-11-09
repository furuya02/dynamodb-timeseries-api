# 3. Connecting Grafana

English | [日本語](../ja/03-grafana.md) ｜ [Docs index](../README.md)

Grafana calls the API with the Infinity data source (yesoreyeram-infinity-datasource). The available authentication methods depend on the Grafana environment.

| Environment | Authentication | Status |
|---|---|---|
| Self-hosted (local Docker) | IAM (access key) | Tested |
| Self-hosted (EC2, etc.) | IAM (AWS SDK Default with the EC2 role) | Based on documentation |
| Grafana Cloud | IAM (access key) or API key | Not tested (based on the Infinity documentation) |
| Amazon Managed Grafana | IAM (access key) | Not tested |

Tested combination: Grafana OSS 13.3.0, Infinity 4.1.5 (November 2026).

## 3.1 Install Infinity

| Environment | How to install |
|---|---|
| Local Docker (this repository) | `grafana/docker-compose.yml` installs it at startup (`GF_PLUGINS_PREINSTALL_SYNC=yesoreyeram-infinity-datasource@4.1.5`) |
| Self-hosted | Search for Infinity in "Administration" → "Plugins and data" → "Plugins" and install it. Or `grafana cli plugins install yesoreyeram-infinity-datasource` |
| Grafana Cloud | Search for Infinity in "Connections" → "Add new connection" and install it |
| Amazon Managed Grafana | Install it from the workspace plugin management (plugin catalog) |

## 3.2 Configure the data source

### (1) Configure with provisioning (for self-hosted)

```bash
pnpm grafana-config      # create it from the deployment outputs
```

This creates `grafana/provisioning/generated/datasources/dynamodb-timeseries-api.yaml`. For a self-hosted Grafana, put this file in Grafana's `provisioning/datasources/`, pass the access key in environment variables (`TSAPI_AWS_ACCESS_KEY_ID` / `TSAPI_AWS_SECRET_ACCESS_KEY`, or `TSAPI_API_KEY` for API key authentication), and start Grafana.

The sample dashboard and alert rule refer to the data source UID `tsapi`. If you create the data source in the UI, you can use the samples as they are if the UID is `tsapi` (the UI does not let you set the UID, so if you created it in the UI, select the data source again when you import the dashboard).

### (2) Configure in the UI (IAM authentication)

Select "Connections" → "Data sources" → "Add new data source" → "Infinity", and set the following.

| Tab | Item | Value |
|---|---|---|
| URL, Headers & Params | Base URL | Deployment output `Endpoint` (including the trailing `/`) |
| Authentication | Auth type | AWS |
| Authentication | Authentication Provider | Access and secret key |
| Authentication | Region | Deployment output `Region` |
| Authentication | Service | `execute-api` (`lambda` for a function URL) |
| Authentication | Access Key ID / Secret Access Key | Access key of the IAM user for Grafana |
| Health check | (custom health check) | Enable it, and set the URL to `<Endpoint>datasets` |

"Save & test" calls /datasets. If it succeeds, the setup is complete.

- The default Service is `monitoring`. Always change it to `execute-api` or `lambda` (otherwise the signature does not match and you get 403)
- When Base URL is set, the query URLs (`query`, `keys`) are appended to it. In this case, the "Security" Allowed hosts setting is not needed

### (3) Configure in the UI (API key authentication)

This is for deployments with `-c auth=apiKey`. Get the key value with the command in the deployment output `GetApiKeyCommand`.

```bash
aws apigateway get-api-key --api-key <ID> --include-value --query value --output text
```

| Tab | Item | Value |
|---|---|---|
| URL, Headers & Params | Base URL | Deployment output `Endpoint` |
| Authentication | Auth type | API Key Value pair |
| Authentication | Key | `x-api-key` |
| Authentication | Value | The API key you got |
| Authentication | (where to add it) | Header |

## 3.3 Notes for each environment

### (1) Self-hosted (local Docker)

These are the steps in [Getting started](01-getting-started.md#17-view-in-grafana). `pnpm grafana-up` loads the data source, the sample dashboard, and the alert rule.

| Item | Content |
|---|---|
| URL | http://localhost:3000/ (listens on 127.0.0.1 only) |
| Login | No login needed to view. To edit, admin / admin |
| Linux | Add `-f grafana/docker-compose.linux.yml` (to point `host.docker.internal` to the host) |
| Stop | `pnpm grafana-down` |

### (2) Self-hosted (EC2, etc., using a role)

You can sign with the EC2 instance role (also ECS task roles, EKS IRSA, etc.) without storing an access key.

1. Attach the policy from the deployment output `GrafanaPolicyArn` to the instance role
2. Set the data source Authentication Provider to "AWS SDK Default" (with provisioning, `jsonData.aws.authType: default`)

`default` must be allowed in the Grafana settings (`[aws] allowed_auth_providers` in grafana.ini). It is allowed by default in Grafana OSS.

To assume a role in another account, deploy with `-c grafanaRoleTrust=<ARN of the assuming principal>` and set the output `GrafanaRoleArn` as the Assume Role ARN of the data source.

### (3) Grafana Cloud (not tested)

- AWS SDK Default is not available. Use "Access and secret key" with the access key of the IAM user for Grafana, or deploy with `-c auth=apiKey` and use an API key
- Grafana Cloud calls the API over the internet. Deploy with `restPublic` (default) or `functionUrl` (`restPrivate` cannot be reached)
- With API key authentication, you can limit the rate with a usage plan (`-c throttleRate` / `-c throttleBurst`)

### (4) Amazon Managed Grafana (not tested)

- Install Infinity from the workspace plugin management
- Connect with "Access and secret key", which uses an access key. Whether the method that uses the workspace role (AWS SDK Default) works has not been checked
- To use a workspace, IAM Identity Center or SAML must be configured

## 3.4 Import the dashboard

The sample dashboard is `grafana/dashboards/room-temp.json`. If you do not use provisioning, import this file with "Dashboards" → "New" → "Import" and select the data source.

To create panels for your own datasets, see [Panels and alerts](04-panels-and-alerts.md).

## Next

- [Panels and alerts](04-panels-and-alerts.md)
- [Deployment options](05-deployment-options.md)
