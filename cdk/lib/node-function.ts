import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';

/**
 * Lambda 関数（Node.js 24 / arm64 / ESM）と、その関数のロググループ（保持日数つき、スタック削除時に削除）。
 * API と取り込みの関数で共通。論理 ID は既存のスタックと変わらないよう、呼び出し側で指定する
 */
export function createNodeFunction(
  scope: Construct,
  ids: { function: string; logGroup: string },
  props: { functionName: string; entry: string; memorySize: number; timeout: cdk.Duration; logRetentionDays: number; environment?: Record<string, string> },
): NodejsFunction {
  const logGroup = new logs.LogGroup(scope, ids.logGroup, {
    logGroupName: `/aws/lambda/${props.functionName}`,
    retention: props.logRetentionDays as logs.RetentionDays,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  return new NodejsFunction(scope, ids.function, {
    functionName: props.functionName,
    entry: props.entry,
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: props.memorySize,
    timeout: props.timeout,
    logGroup,
    environment: props.environment,
    bundling: { format: OutputFormat.ESM, target: 'node24' },
  });
}
