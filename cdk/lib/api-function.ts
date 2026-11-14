import * as fs from 'node:fs';
import * as path from 'node:path';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import type { ResolvedDataset } from './config';
import { PROJECT } from './constants';
import { createNodeFunction } from './node-function';

const LAMBDA_DIR = path.join(__dirname, '../lambda/api');

/**
 * 検証済みの設定を JSON に書き出し、Lambda のバンドルに含める。
 * 環境変数は 4KB の上限があり、esbuild の define はシェル経由で正規表現の $ などが壊れるため使わない
 */
export function writeGeneratedConfig(datasets: Record<string, ResolvedDataset>): void {
  fs.writeFileSync(path.join(LAMBDA_DIR, 'datasets.generated.json'), JSON.stringify(datasets, null, 2));
}

/** 設定に書かれたテーブル・インデックスの ARN（重複は 1 つ） */
export function queryResourceArns(stack: cdk.Stack, datasets: Record<string, ResolvedDataset>): string[] {
  const arns = new Set<string>();
  for (const d of Object.values(datasets)) {
    const arn = stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: d.table });
    arns.add(d.index ? `${arn}/index/${d.index}` : arn);
  }
  return [...arns];
}

/** API の Lambda 関数とロググループ。設定に書かれたテーブル・インデックスへの dynamodb:Query だけを付ける */
export function createApiFunction(scope: Construct, props: { datasets: Record<string, ResolvedDataset>; logRetentionDays: number }): NodejsFunction {
  const stack = cdk.Stack.of(scope);
  writeGeneratedConfig(props.datasets);
  const fn = createNodeFunction(
    scope,
    { function: 'ApiFunction', logGroup: 'ApiFunctionLogs' },
    {
      functionName: PROJECT,
      entry: path.join(LAMBDA_DIR, 'index.ts'),
      memorySize: 512,
      timeout: cdk.Duration.seconds(29),
      logRetentionDays: props.logRetentionDays,
    },
  );
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: queryResourceArns(stack, props.datasets) }));
  return fn;
}
