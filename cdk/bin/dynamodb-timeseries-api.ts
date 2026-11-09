#!/usr/bin/env node
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { ConfigError, loadConfig, type ResolvedDataset } from '../lib/config';
import { DynamodbTimeseriesApiStack } from '../lib/dynamodb-timeseries-api-stack';
import { checkOptionsAgainstConfig, type DeployOptions, readOptions } from '../lib/options';

const app = new cdk.App();

// -c config=<path> で設定ファイルを差し替えられる（既定: リポジトリ直下の config/datasets.yaml）
const configPath = path.resolve(app.node.tryGetContext('config') ?? path.join(__dirname, '../../config/datasets.yaml'));

let datasets: Record<string, ResolvedDataset>;
let options: DeployOptions;
try {
  datasets = loadConfig(configPath);
  options = readOptions((key) => app.node.tryGetContext(key));
  checkOptionsAgainstConfig(datasets, options);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

new DynamodbTimeseriesApiStack(app, 'DynamodbTimeseriesApiStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1' },
  datasets,
  options,
});
