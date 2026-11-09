# Security Policy / セキュリティポリシー

## Reporting a vulnerability / 脆弱性の報告

Please do not open a public issue. Report it privately through [GitHub Security Advisories](https://github.com/furuya02/dynamodb-timeseries-api/security/advisories/new).

公開の Issue は使わず、[GitHub Security Advisories](https://github.com/furuya02/dynamodb-timeseries-api/security/advisories/new) から非公開で報告してください。

## Scope / 対象

- The API (Lambda), the CDK app, and the scripts in this repository / このリポジトリの API（Lambda）、CDK アプリ、スクリプト
- Misconfigurations caused by the defaults of this project (for example, IAM permissions that are broader than documented) / このプロジェクトの既定値が原因の設定不備（ドキュメントより広い IAM 権限など）

Vulnerabilities in Grafana, the Infinity data source, AWS services, or other dependencies should be reported to their maintainers.

Grafana、Infinity データソース、AWS のサービス、その他の依存ライブラリの脆弱性は、それぞれの提供元に報告してください。

## Supported versions / 対象のバージョン

Only the latest release receives fixes. / 修正は最新のリリースにのみ行います。
