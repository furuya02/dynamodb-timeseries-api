import * as path from 'node:path';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { COLD_DATA_PREFIX } from '../lambda/api/cold/sql';
import { queryResourceArns } from './api-function';
import type { ColdStore } from './cold-store';
import type { ResolvedDataset } from './config';
import { PROJECT } from './constants';

const INGEST_DIR = path.join(__dirname, '../lambda/ingest');
export const SCHEDULED_INGEST_FUNCTION = `${PROJECT}-cold-ingest`;

/** cold を設定したデータセットだけ */
export const coldDatasets = (datasets: Record<string, ResolvedDataset>): Record<string, ResolvedDataset> =>
  Object.fromEntries(Object.entries(datasets).filter(([, d]) => d.cold));

/**
 * 定期実行の取り込み（-c coldIngest=scheduled）。
 * EventBridge Scheduler が毎日 01:00 UTC に Lambda を呼び、前日分（UTC）を DynamoDB の Query で読んで S3 に書く
 */
export function createScheduledIngest(
  scope: Construct,
  props: { datasets: Record<string, ResolvedDataset>; store: ColdStore; logRetentionDays: number },
): NodejsFunction {
  const stack = cdk.Stack.of(scope);
  const logGroup = new logs.LogGroup(scope, 'ColdIngestLogs', {
    logGroupName: `/aws/lambda/${SCHEDULED_INGEST_FUNCTION}`,
    retention: props.logRetentionDays as logs.RetentionDays,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const fn = new NodejsFunction(scope, 'ColdIngestFunction', {
    functionName: SCHEDULED_INGEST_FUNCTION,
    entry: path.join(INGEST_DIR, 'scheduled.ts'),
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 1024,
    timeout: cdk.Duration.minutes(15),
    logGroup,
    environment: { TSAPI_COLD_BUCKET: props.store.bucket.bucketName },
    bundling: { format: OutputFormat.ESM, target: 'node24' },
  });
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: queryResourceArns(stack, coldDatasets(props.datasets)) }));
  props.store.bucket.grantReadWrite(fn, `${COLD_DATA_PREFIX}*`);
  props.store.bucket.grantDelete(fn, `${COLD_DATA_PREFIX}*`);

  new scheduler.Schedule(scope, 'ColdIngestSchedule', {
    scheduleName: SCHEDULED_INGEST_FUNCTION,
    description: 'Ingests the previous day (UTC) into the cold storage',
    schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '1', timeZone: cdk.TimeZone.ETC_UTC }),
    target: new targets.LambdaInvoke(fn, { retryAttempts: 2 }),
  });
  return fn;
}
