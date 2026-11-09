import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { createApiFunction } from './api-function';
import { createScheduledIngest } from './cold-ingest';
import { createColdStore, grantColdRead } from './cold-store';
import { createStreamIngest } from './cold-stream';
import type { ResolvedDataset } from './config';
import { createEndpoint } from './endpoint';
import { createGrafanaAccess } from './grafana-access';
import type { DeployOptions } from './options';
import { createSampleTable } from './sample-table';

export interface DynamodbTimeseriesApiStackProps extends cdk.StackProps {
  /** 検証済みの config/datasets.yaml */
  datasets: Record<string, ResolvedDataset>;
  /** デプロイオプション（cdk deploy -c 名前=値） */
  options: DeployOptions;
}

/**
 * Lambda（API）と公開形態ごとの入口、Grafana 用の IAM、サンプルテーブル、コールドストアをまとめたスタック。
 * 各部品はスタックを scope として直接作る（子のコンストラクトにすると論理 ID が変わり、既存の環境でリソースが置き換わるため）
 */
export class DynamodbTimeseriesApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DynamodbTimeseriesApiStackProps) {
    super(scope, id, props);
    const o = props.options;

    const fn = createApiFunction(this, { datasets: props.datasets, logRetentionDays: o.logRetentionDays });
    const sampleTable = o.sample ? createSampleTable(this, { stream: o.cold && o.coldIngest === 'stream' }) : undefined;
    if (o.cold) {
      const store = createColdStore(this, o);
      grantColdRead(fn, store);
      const ingest = { datasets: props.datasets, store, logRetentionDays: o.logRetentionDays };
      if (o.coldIngest === 'scheduled') createScheduledIngest(this, ingest);
      else createStreamIngest(this, { ...ingest, sampleTable });
      new cdk.CfnOutput(this, 'ColdBucketName', { value: store.bucket.bucketName, description: 'コールドストアの S3 バケット' });
    }
    const endpoint = createEndpoint(this, fn, o);
    new cdk.CfnOutput(this, 'Endpoint', { value: endpoint.url, description: 'Infinity の URL に設定するベース URL（末尾に query?... を付ける）' });
    if (o.auth === 'iam') createGrafanaAccess(this, endpoint.invokeStatements, o);
    new cdk.CfnOutput(this, 'Region', { value: this.region, description: 'Infinity の AWS 認証に設定するリージョン' });
  }
}
