import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cdk from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { PROJECT } from './constants';
import type { DeployOptions } from './options';

export interface Endpoint {
  /** Infinity の URL に設定するベース URL（末尾に query?... を付ける） */
  url: string;
  /** Grafana がこの API を呼ぶのに必要な権限（IAM 認証のとき） */
  invokeStatements: iam.PolicyStatement[];
}

/** 公開形態（-c exposure）ごとに API の入口を作る */
export function createEndpoint(scope: Construct, fn: lambda.Function, o: DeployOptions): Endpoint {
  return o.exposure === 'functionUrl' ? createFunctionUrl(fn) : createRestApi(scope, fn, o);
}

function createFunctionUrl(fn: lambda.Function): Endpoint {
  const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
  return {
    url: url.url,
    // CDK の grantInvokeUrl と同じ 2 つを付ける。同じアカウントの IAM ユーザーでは InvokeFunctionUrl だけで呼べた（2026/11/05 実測）が、
    // InvokeFunction は関数 URL 経由に限る条件付きで許可の範囲は増えないため、CDK に合わせて残している
    invokeStatements: [
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunctionUrl'],
        resources: [fn.functionArn],
        conditions: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
      }),
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [fn.functionArn],
        conditions: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
      }),
    ],
  };
}

/** restPublic / restPrivate の REST API。/query /datasets /keys を同じ Lambda で処理する */
function createRestApi(scope: Construct, fn: lambda.IFunction, o: DeployOptions): Endpoint {
  const isPrivate = o.exposure === 'restPrivate';
  const api = new apigw.RestApi(scope, 'Api', {
    restApiName: PROJECT,
    endpointConfiguration: isPrivate
      ? {
          types: [apigw.EndpointType.PRIVATE],
          vpcEndpoints: [ec2.InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(scope, 'Vpce', { vpcEndpointId: requireVpcEndpointId(o), port: 443 })],
        }
      : { types: [apigw.EndpointType.REGIONAL] },
    policy: isPrivate ? privateApiPolicy(o) : undefined,
    deployOptions: { stageName: 'v1' },
    defaultMethodOptions:
      o.auth === 'iam' ? { authorizationType: apigw.AuthorizationType.IAM } : { authorizationType: apigw.AuthorizationType.NONE, apiKeyRequired: true },
  });
  // RestApi が自動で作る出力（ApiEndpointXXXX）は、スタックの Endpoint と重複するため取り除く
  api.node.tryRemoveChild('Endpoint');
  const integration = new apigw.LambdaIntegration(fn);
  for (const p of ['query', 'datasets', 'keys']) api.root.addResource(p).addMethod('GET', integration);
  if (o.auth === 'apiKey') addApiKey(scope, api, o);
  return {
    url: api.url,
    invokeStatements: [
      new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources: [api.arnForExecuteApi('GET', '/*', api.deploymentStage.stageName)] }),
    ],
  };
}

/** API キー（Grafana Cloud 向け）と、レートを制限する使用量プラン */
function addApiKey(scope: Construct, api: apigw.RestApi, o: DeployOptions): void {
  const key = api.addApiKey('GrafanaApiKey', { apiKeyName: `${PROJECT}-grafana` });
  const plan = api.addUsagePlan('UsagePlan', {
    name: PROJECT,
    throttle: { rateLimit: o.throttleRate, burstLimit: o.throttleBurst },
    apiStages: [{ api, stage: api.deploymentStage }],
  });
  plan.addApiKey(key);
  // キーの値は CloudFormation の出力に出さない。取得コマンドを案内する
  new cdk.CfnOutput(scope, 'GetApiKeyCommand', { value: `aws apigateway get-api-key --api-key ${key.keyId} --include-value --query value --output text` });
}

/** restPrivate の VPC エンドポイント ID（readOptions で必須にしているが、直接呼ばれた場合に備えて確かめる） */
function requireVpcEndpointId(o: DeployOptions): string {
  if (!o.vpcEndpointId) throw new Error('exposure=restPrivate requires vpcEndpointId');
  return o.vpcEndpointId;
}

/**
 * restPrivate のリソースポリシー。指定した VPC エンドポイント以外からの呼び出しを拒否する。
 * IAM 認証ならこのアカウントのプリンシパル（権限は Grafana 用ポリシーで絞る）、API キー認証なら誰でも（キーで絞る）
 */
export function privateApiPolicy(o: DeployOptions): iam.PolicyDocument {
  const principal = o.auth === 'iam' ? new iam.AccountRootPrincipal() : new iam.AnyPrincipal();
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({ principals: [principal], actions: ['execute-api:Invoke'], resources: ['execute-api:/*'] }),
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['execute-api:Invoke'],
        resources: ['execute-api:/*'],
        conditions: { StringNotEquals: { 'aws:SourceVpce': requireVpcEndpointId(o) } },
      }),
    ],
  });
}
