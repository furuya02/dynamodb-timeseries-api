import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { SAMPLE_TABLE } from './constants';

/** サンプルテーブル（-c sample=true）。オンデマンド課金で、cdk destroy で一緒に消える */
/** stream: -c coldIngest=stream のとき、ストリーム（新しいイメージ）を有効にする */
export function createSampleTable(scope: Construct, props: { stream?: boolean } = {}): dynamodb.TableV2 {
  return new dynamodb.TableV2(scope, 'SampleTable', {
    tableName: SAMPLE_TABLE,
    partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'ts', type: dynamodb.AttributeType.NUMBER },
    billing: dynamodb.Billing.onDemand(),
    // コールドストアを使うときに、hotRetention より古いアイテムを消す（この属性がないアイテムは消えない）
    timeToLiveAttribute: 'expiresAt',
    dynamoStream: props.stream ? dynamodb.StreamViewType.NEW_IMAGE : undefined,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}
