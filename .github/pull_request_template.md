## Summary / 概要

<!-- What and why / 何を、なぜ変えたか -->

## Checklist / 確認

- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` pass
- [ ] `pnpm test:integration` passes (when the change touches DynamoDB access) / DynamoDB の読み込みに関わる変更なら結合テストも通した
- [ ] Docs updated (README / docs/en / docs/ja) / 手順書を更新した（英語・日本語の両方）
- [ ] CHANGELOG.md updated (user-facing changes) / 利用者に見える変更は CHANGELOG.md に追記した
- [ ] No secrets or account IDs in code, tests, or screenshots / 秘密情報やアカウント ID を含めていない
