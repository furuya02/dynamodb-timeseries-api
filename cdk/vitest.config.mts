import { defineConfig } from 'vitest/config';

// unit: AWS も Docker も不要なテスト / integration: DynamoDB Local（既定 http://localhost:8000）を使うテスト
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/cdk/**/*.test.ts'],
          globalSetup: ['test/unit/global-setup.ts'],
          testTimeout: 60_000, // CDK のテストは NodejsFunction のバンドルを含むため時間がかかる
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          env: {
            AWS_ENDPOINT_URL_DYNAMODB: process.env.AWS_ENDPOINT_URL_DYNAMODB ?? 'http://localhost:8000',
            AWS_REGION: 'ap-northeast-1',
            AWS_ACCESS_KEY_ID: 'local',
            AWS_SECRET_ACCESS_KEY: 'local',
            AWS_SESSION_TOKEN: '',
            AWS_PROFILE: '',
          },
          testTimeout: 30_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['lambda/**/*.ts', 'lib/**/*.ts'],
      exclude: ['lambda/api/index.ts', 'lambda/ingest/scheduled.ts', 'lambda/ingest/stream.ts', 'lambda/api/*.d.json.ts'],
    },
  },
});
