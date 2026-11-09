import * as path from 'node:path';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { COLD_DATA_PREFIX } from '../lambda/api/cold/sql';
import { coldDatasets } from './cold-ingest';
import type { ColdStore } from './cold-store';
import type { ResolvedDataset } from './config';
import { PROJECT, SAMPLE_TABLE } from './constants';

const INGEST_DIR = path.join(__dirname, '../lambda/ingest');
export const STREAM_INGEST_FUNCTION = `${PROJECT}-cold-stream`;
export const COLD_FIREHOSE = `${PROJECT}-cold`;
const ERROR_PREFIX = 'firehose-errors/';

/**
 * Firehose: JSON（1 分の集計）を Glue テーブルの定義で Parquet に変換し、
 * dataset / dt の値で data/dataset=名前/dt=yyyy-MM-dd/ に分けて書く（動的パーティショニング）。
 * コールドストアを読むのは hotRetention より前なので、すぐに書く必要はない。ファイルの数を減らすため最大の 15 分ためてから書く
 */
function createFirehose(scope: Construct, store: ColdStore): firehose.CfnDeliveryStream {
  const stack = cdk.Stack.of(scope);
  const role = new iam.Role(scope, 'ColdFirehoseRole', {
    roleName: `${PROJECT}-cold-firehose`,
    assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': stack.account } } }),
  });
  store.bucket.grantReadWrite(role, `${COLD_DATA_PREFIX}*`);
  store.bucket.grantReadWrite(role, `${ERROR_PREFIX}*`);
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetTableVersion', 'glue:GetTableVersions'],
      resources: [
        stack.formatArn({ service: 'glue', resource: 'catalog' }),
        stack.formatArn({ service: 'glue', resource: 'database', resourceName: store.database }),
        stack.formatArn({ service: 'glue', resource: 'table', resourceName: `${store.database}/${store.table}` }),
      ],
    }),
  );
  const stream = new firehose.CfnDeliveryStream(scope, 'ColdFirehose', {
    deliveryStreamName: COLD_FIREHOSE,
    deliveryStreamType: 'DirectPut',
    extendedS3DestinationConfiguration: {
      bucketArn: store.bucket.bucketArn,
      roleArn: role.roleArn,
      prefix: `${COLD_DATA_PREFIX}dataset=!{partitionKeyFromQuery:dataset}/dt=!{partitionKeyFromQuery:dt}/`,
      errorOutputPrefix: `${ERROR_PREFIX}!{firehose:error-output-type}/!{timestamp:yyyy-MM-dd}/`,
      // Parquet に変換するときは 64MB 以上が必要
      bufferingHints: { intervalInSeconds: 900, sizeInMBs: 128 },
      dynamicPartitioningConfiguration: { enabled: true, retryOptions: { durationInSeconds: 300 } },
      processingConfiguration: {
        enabled: true,
        processors: [
          {
            type: 'MetadataExtraction',
            parameters: [
              { parameterName: 'MetadataExtractionQuery', parameterValue: '{dataset: .dataset, dt: .dt}' },
              { parameterName: 'JsonParsingEngine', parameterValue: 'JQ-1.6' },
            ],
          },
        ],
      },
      dataFormatConversionConfiguration: {
        enabled: true,
        inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
        outputFormatConfiguration: { serializer: { parquetSerDe: { compression: 'SNAPPY' } } },
        schemaConfiguration: { databaseName: store.database, tableName: store.table, roleArn: role.roleArn, region: stack.region, versionId: 'LATEST' },
      },
    },
  });
  // 権限が付く前に作ると、Glue のテーブルを読めずに作成が失敗するため
  stream.node.addDependency(role);
  return stream;
}

/** 既存のテーブルのストリームの ARN をデプロイ時に読む（ストリームは利用者がテーブルで有効にしておく） */
function lookupStreamArn(scope: Construct, table: string, index: number): string {
  const stack = cdk.Stack.of(scope);
  const call: cr.AwsSdkCall = {
    service: 'DynamoDB',
    action: 'describeTable',
    parameters: { TableName: table },
    physicalResourceId: cr.PhysicalResourceId.of(`${table}-stream`),
    outputPaths: ['Table.LatestStreamArn'],
  };
  const r = new cr.AwsCustomResource(scope, `ColdStreamArn${index}`, {
    onCreate: call,
    onUpdate: call,
    policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: table })] }),
    installLatestAwsSdk: false,
  });
  return r.getResponseField('Table.LatestStreamArn');
}

/**
 * ストリームの取り込み（-c coldIngest=stream）。
 * DynamoDB Streams（INSERT だけ）→ Lambda（1 分の集計）→ Firehose（Parquet）→ S3
 */
export function createStreamIngest(
  scope: Construct,
  props: { datasets: Record<string, ResolvedDataset>; store: ColdStore; logRetentionDays: number; sampleTable?: dynamodb.TableV2 },
): NodejsFunction {
  const stack = cdk.Stack.of(scope);
  const delivery = createFirehose(scope, props.store);
  const logGroup = new logs.LogGroup(scope, 'ColdStreamLogs', {
    logGroupName: `/aws/lambda/${STREAM_INGEST_FUNCTION}`,
    retention: props.logRetentionDays as logs.RetentionDays,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const fn = new NodejsFunction(scope, 'ColdStreamFunction', {
    functionName: STREAM_INGEST_FUNCTION,
    entry: path.join(INGEST_DIR, 'stream.ts'),
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 512,
    timeout: cdk.Duration.minutes(1),
    logGroup,
    environment: { TSAPI_COLD_FIREHOSE: COLD_FIREHOSE },
    bundling: { format: OutputFormat.ESM, target: 'node24' },
  });
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['firehose:PutRecordBatch'], resources: [delivery.attrArn] }));

  // ListStreams はリソースを指定できない
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:ListStreams'], resources: ['*'] }));
  const tables = [...new Set(Object.values(coldDatasets(props.datasets)).map((d) => d.table))];
  tables.forEach((table, i) => {
    // tableName はトークンなので、名前の定数と比べる
    const streamArn = props.sampleTable && table === SAMPLE_TABLE ? (props.sampleTable.tableStreamArn as string) : lookupStreamArn(scope, table, i);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator'],
        resources: [stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: `${table}/stream/*` })],
      }),
    );
    new lambda.EventSourceMapping(scope, `ColdStreamMapping${i}`, {
      target: fn,
      eventSourceArn: streamArn,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 1000,
      maxBatchingWindow: cdk.Duration.seconds(30),
      retryAttempts: 3,
      bisectBatchOnError: true,
      // 追加（INSERT）だけを取り込む。更新・削除（TTL による削除を含む）は呼び出し自体を省く
      filters: [lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT') })],
    });
  });
  return fn;
}
