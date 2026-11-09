# Contributing

English | [日本語](CONTRIBUTING.ja.md)

Thank you for your interest in this project. Issues and pull requests are welcome in English or Japanese.

## Reporting issues

- Bugs: use the bug report template. Include the relevant part of `datasets.yaml`, the output of `pnpm check`, or the CloudWatch Logs line (`type = query`). Remove secrets and AWS account IDs
- Feature requests: describe your table design and what you want to show in Grafana. Settings that make more table designs readable are especially welcome
- Security issues: do not open a public issue. See [SECURITY.md](SECURITY.md)

## Development setup

```bash
pnpm install
pnpm lint            # Biome
pnpm typecheck       # TypeScript
pnpm test            # unit tests and CDK template tests (no AWS, no Docker)

docker run -d --rm -p 8000:8000 amazon/dynamodb-local:3.3.2 -jar DynamoDBLocal.jar -inMemory
pnpm test:integration
```

Requirements: Node.js 22+, pnpm 10+, Docker. Use pnpm, not npm / npx.

See [Development](docs/en/08-development.md) for the code structure and the test layout.

## Pull requests

1. Create a branch from `main`
2. Make the change with tests
   - New settings or parameters need unit tests. Add integration tests when the behavior depends on DynamoDB
   - CDK changes need template tests in `cdk/test/cdk`
3. Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:integration`
4. Update the docs in both languages (`docs/en` and `docs/ja`, `README.md` and `README.ja.md`) when user-facing behavior changes
5. Add an entry to `CHANGELOG.md` under "Unreleased"
6. Open a pull request and fill in the template

## Guidelines

- Keep the API read-only and Query-only. Do not add Scan or write operations
- Keep IAM permissions minimal. Explain any new permission in the pull request
- Do not change CloudFormation logical IDs of existing resources (it replaces resources in existing deployments). If it is unavoidable, say so in the CHANGELOG
- Keep error messages actionable: say what is wrong and how to fix it
- Do not include secrets, access keys, or account IDs in code, tests, docs, or screenshots

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
