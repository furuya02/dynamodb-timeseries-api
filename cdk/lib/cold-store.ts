import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { COLD_COLUMNS, COLD_DATA_PREFIX, COLD_PARTITIONS } from '../lambda/api/cold/sql';
import { PROJECT } from './constants';
import type { DeployOptions } from './options';

/** Glue のデータベース名（英小文字・数字・_ のみ） */
export const COLD_DATABASE = PROJECT.replaceAll('-', '_');
export const COLD_TABLE = 'cold';
export const ATHENA_RESULTS_PREFIX = 'athena-results/';

export interface ColdStore {
  bucket: s3.Bucket;
  database: string;
  table: string;
  workgroup: string;
}

/**
 * コールドストア（-c cold=true）。
 * - S3: data/dataset=名前/dt=yyyy-MM-dd/*.parquet（1 分の集計）と、Athena の結果（1 日で削除）
 * - Glue: パーティション射影でパーティションを登録しない（取り込み後の MSCK REPAIR などは不要）
 * - Athena: 1 回の問い合わせで読む量の上限（-c coldScanLimitGb）をワークグループで強制する
 */
export function createColdStore(scope: Construct, o: DeployOptions): ColdStore {
  const stack = cdk.Stack.of(scope);
  const destroy = o.coldRemovalPolicy === 'destroy';
  const bucket = new s3.Bucket(scope, 'ColdBucket', {
    // S3 のバケット名は全世界で一意なので、サフィックス（既定はアカウント ID）を付ける
    bucketName: `${PROJECT}-cold-${o.bucketSuffix ?? stack.account}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    lifecycleRules: [{ prefix: ATHENA_RESULTS_PREFIX, expiration: cdk.Duration.days(1) }],
    removalPolicy: destroy ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    autoDeleteObjects: destroy,
  });

  const database = new glue.CfnDatabase(scope, 'ColdDatabase', {
    catalogId: stack.account,
    databaseInput: { name: COLD_DATABASE, description: `${PROJECT} のコールドストア` },
  });
  const location = `s3://${bucket.bucketName}/${COLD_DATA_PREFIX}`;
  const table = new glue.CfnTable(scope, 'ColdTable', {
    catalogId: stack.account,
    databaseName: COLD_DATABASE,
    tableInput: {
      name: COLD_TABLE,
      tableType: 'EXTERNAL_TABLE',
      partitionKeys: COLD_PARTITIONS.map(([name, type]) => ({ name, type })),
      parameters: {
        classification: 'parquet',
        'projection.enabled': 'true',
        // データセット名は問い合わせの WHERE に必ず書く（injected）
        'projection.dataset.type': 'injected',
        'projection.dt.type': 'date',
        'projection.dt.format': 'yyyy-MM-dd',
        'projection.dt.range': '2000-01-01,NOW',
        'projection.dt.interval': '1',
        'projection.dt.interval.unit': 'DAYS',
        'storage.location.template': `${location}dataset=\${dataset}/dt=\${dt}/`,
      },
      storageDescriptor: {
        location,
        columns: COLD_COLUMNS.map(([name, type]) => ({ name, type })),
        inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
        outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
        serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
      },
    },
  });
  table.node.addDependency(database);

  const workgroup = new athena.CfnWorkGroup(scope, 'ColdWorkGroup', {
    name: PROJECT,
    description: `${PROJECT} の API がコールドストアを読むためのワークグループ`,
    recursiveDeleteOption: true, // cdk destroy のときにクエリの履歴ごと消す
    workGroupConfiguration: {
      enforceWorkGroupConfiguration: true,
      bytesScannedCutoffPerQuery: o.coldScanLimitGb * 1024 ** 3,
      engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
      publishCloudWatchMetricsEnabled: false,
      resultConfiguration: {
        outputLocation: `s3://${bucket.bucketName}/${ATHENA_RESULTS_PREFIX}`,
        encryptionConfiguration: { encryptionOption: 'SSE_S3' },
      },
    },
  });

  return { bucket, database: COLD_DATABASE, table: COLD_TABLE, workgroup: workgroup.name };
}

/** API の Lambda にコールドストアを読む権限と、場所の環境変数を付ける */
export function grantColdRead(fn: lambda.Function, c: ColdStore): void {
  const stack = cdk.Stack.of(fn);
  fn.addEnvironment('TSAPI_COLD_DATABASE', c.database);
  fn.addEnvironment('TSAPI_COLD_TABLE', c.table);
  fn.addEnvironment('TSAPI_COLD_WORKGROUP', c.workgroup);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution'],
      resources: [stack.formatArn({ service: 'athena', resource: 'workgroup', resourceName: c.workgroup })],
    }),
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['glue:GetDatabase', 'glue:GetTable'],
      resources: [
        stack.formatArn({ service: 'glue', resource: 'catalog' }),
        stack.formatArn({ service: 'glue', resource: 'database', resourceName: c.database }),
        stack.formatArn({ service: 'glue', resource: 'table', resourceName: `${c.database}/${c.table}` }),
      ],
    }),
  );
  c.bucket.grantRead(fn, `${COLD_DATA_PREFIX}*`);
  c.bucket.grantReadWrite(fn, `${ATHENA_RESULTS_PREFIX}*`);
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetBucketLocation'], resources: [c.bucket.bucketArn] }));
}
