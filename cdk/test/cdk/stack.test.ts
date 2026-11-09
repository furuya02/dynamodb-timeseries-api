import * as fs from 'node:fs';
import * as path from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type ResolvedDataset } from '../../lib/config';
import { DynamodbTimeseriesApiStack } from '../../lib/dynamodb-timeseries-api-stack';
import { readOptions } from '../../lib/options';

// synth のたびに lambda/api/datasets.generated.json が書き換わるため、テストの前後で保存・復元する
const generated = path.join(__dirname, '../../lambda/api/datasets.generated.json');
let saved: string | undefined;
beforeAll(() => {
  saved = fs.existsSync(generated) ? fs.readFileSync(generated, 'utf8') : undefined;
});
afterAll(() => {
  if (saved === undefined) fs.rmSync(generated, { force: true });
  else fs.writeFileSync(generated, saved);
});

const sample = loadConfig(path.join(__dirname, '../../../config/datasets.yaml'));
const ENV = { account: '123456789012', region: 'ap-northeast-1' };

function synth(context: Record<string, string> = {}, datasets: Record<string, ResolvedDataset> = sample): Template {
  const app = new cdk.App();
  const stack = new DynamodbTimeseriesApiStack(app, 'TestStack', { env: ENV, datasets, options: readOptions((k) => context[k]) });
  return Template.fromStack(stack);
}

describe('既定（restPublic + IAM 認証）', () => {
  const t = synth();

  it('Lambda: Node.js 24 / arm64 / 512MB / 29 秒、名前は dynamodb-timeseries-api', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'dynamodb-timeseries-api',
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 512,
      Timeout: 29,
    });
  });

  it('ロググループは保持 7 日、スタック削除時に削除', () => {
    t.hasResource('AWS::Logs::LogGroup', {
      Properties: { LogGroupName: '/aws/lambda/dynamodb-timeseries-api', RetentionInDays: 7 },
      DeletionPolicy: 'Delete',
    });
  });

  it('Lambda の権限は、設定に書かれたテーブルへの dynamodb:Query だけ', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'dynamodb:Query',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':dynamodb:ap-northeast-1:123456789012:table/dynamodb-timeseries-api-sample']],
            },
          },
        ],
      },
    });
  });

  it('REST API（REGIONAL、ステージ v1）の /query /datasets /keys は、すべて IAM 認証の GET', () => {
    t.hasResourceProperties('AWS::ApiGateway::RestApi', { Name: 'dynamodb-timeseries-api', EndpointConfiguration: { Types: ['REGIONAL'] } });
    t.hasResourceProperties('AWS::ApiGateway::Stage', { StageName: 'v1' });
    expect(
      Object.values(t.findResources('AWS::ApiGateway::Resource'))
        .map((r) => r.Properties.PathPart)
        .sort(),
    ).toEqual(['datasets', 'keys', 'query']);
    const methods = Object.values(t.findResources('AWS::ApiGateway::Method'));
    expect(methods).toHaveLength(3);
    expect(methods.every((m) => m.Properties.HttpMethod === 'GET' && m.Properties.AuthorizationType === 'AWS_IAM')).toBe(true);
  });

  it('Grafana 用の管理ポリシーは execute-api:Invoke（ステージ v1 の GET）だけ', () => {
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'dynamodb-timeseries-api-invoke',
      PolicyDocument: {
        Statement: [
          {
            Action: 'execute-api:Invoke',
            Effect: 'Allow',
            Resource: { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('/GET/\\*$')])] },
          },
        ],
      },
    });
  });

  it('IAM ユーザー・ロール・サンプルテーブル・API キーは作らない', () => {
    t.resourceCountIs('AWS::IAM::User', 0);
    t.resourceCountIs('AWS::IAM::AccessKey', 0);
    t.resourceCountIs('AWS::DynamoDB::GlobalTable', 0);
    t.resourceCountIs('AWS::ApiGateway::ApiKey', 0);
  });

  it('出力は Endpoint / Region / GrafanaPolicyArn（RestApi の自動出力は除く）', () => {
    expect(Object.keys(t.findOutputs('*')).sort()).toEqual(['Endpoint', 'GrafanaPolicyArn', 'Region']);
  });
});

describe('-c sample=true -c grafanaUser=true -c logRetentionDays=30', () => {
  const t = synth({ sample: 'true', grafanaUser: 'true', logRetentionDays: '30' });

  it('サンプルテーブル: deviceId（S）+ ts（N）、オンデマンド、スタック削除時に削除', () => {
    t.hasResource('AWS::DynamoDB::GlobalTable', {
      Properties: {
        TableName: 'dynamodb-timeseries-api-sample',
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'deviceId', KeyType: 'HASH' },
          { AttributeName: 'ts', KeyType: 'RANGE' },
        ],
      },
      DeletionPolicy: 'Delete',
    });
  });

  it('Grafana 用 IAM ユーザーに管理ポリシーを付け、アクセスキーは作らない', () => {
    t.hasResourceProperties('AWS::IAM::User', {
      UserName: 'dynamodb-timeseries-api-grafana',
      ManagedPolicyArns: [{ Ref: Match.stringLikeRegexp('^GrafanaInvokePolicy') }],
    });
    t.resourceCountIs('AWS::IAM::AccessKey', 0);
    t.hasOutput('CreateAccessKeyCommand', {
      Value: { 'Fn::Join': ['', ['aws iam create-access-key --user-name ', { Ref: Match.stringLikeRegexp('^GrafanaUser') }]] },
    });
  });

  it('ログの保持日数', () => {
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });
});

describe('-c grafanaRoleTrust', () => {
  it('指定した ARN だけが引き受けられるロールを作る', () => {
    const t = synth({ grafanaRoleTrust: 'arn:aws:iam::111122223333:role/grafana' });
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'dynamodb-timeseries-api-grafana',
      AssumeRolePolicyDocument: { Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::111122223333:role/grafana' } }] },
    });
    t.hasOutput('GrafanaRoleArn', {});
  });
});

describe('-c exposure=functionUrl', () => {
  const t = synth({ exposure: 'functionUrl' });

  it('IAM 認証の関数 URL を作り、REST API は作らない', () => {
    t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
    t.resourceCountIs('AWS::ApiGateway::RestApi', 0);
  });

  it('Grafana 用ポリシーは関数 URL 経由の呼び出しだけ（条件付き）', () => {
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: [
          { Action: 'lambda:InvokeFunctionUrl', Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } } },
          { Action: 'lambda:InvokeFunction', Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } } },
        ].map((s) => Match.objectLike(s)),
      },
    });
  });
});

describe('-c auth=apiKey', () => {
  const t = synth({ auth: 'apiKey', throttleRate: '5', throttleBurst: '10' });

  it('メソッドは API キー必須（IAM 認証なし）', () => {
    const methods = Object.values(t.findResources('AWS::ApiGateway::Method'));
    expect(methods.every((m) => m.Properties.AuthorizationType === 'NONE' && m.Properties.ApiKeyRequired === true)).toBe(true);
  });

  it('API キーと、レートを制限する使用量プランを作る', () => {
    t.hasResourceProperties('AWS::ApiGateway::ApiKey', { Name: 'dynamodb-timeseries-api-grafana' });
    t.hasResourceProperties('AWS::ApiGateway::UsagePlan', { UsagePlanName: 'dynamodb-timeseries-api', Throttle: { RateLimit: 5, BurstLimit: 10 } });
    t.resourceCountIs('AWS::ApiGateway::UsagePlanKey', 1);
  });

  it('キーの値は出力せず取得コマンドを出す。Grafana 用 IAM は作らない', () => {
    t.hasOutput('GetApiKeyCommand', { Value: { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('get-api-key --api-key')])] } });
    t.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
  });
});

describe('-c exposure=restPrivate', () => {
  const vpce = 'vpce-0123456789abcdef0';

  it.each([
    ['iam', { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::123456789012:root']] } }],
    ['apiKey', { AWS: '*' }],
  ])('auth=%s: 指定の VPC エンドポイント以外を拒否するリソースポリシー', (auth, principal) => {
    const t = synth({ exposure: 'restPrivate', vpcEndpointId: vpce, auth });
    t.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: [vpce] },
      Policy: {
        Statement: [
          { Action: 'execute-api:Invoke', Effect: 'Allow', Principal: principal, Resource: 'execute-api:/*' },
          {
            Action: 'execute-api:Invoke',
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Resource: 'execute-api:/*',
            Condition: { StringNotEquals: { 'aws:SourceVpce': vpce } },
          },
        ],
      },
    });
  });
});

describe('IAM の権限の範囲（設定ファイルによる）', () => {
  it('GSI を使うデータセットはインデックスの ARN、同じテーブルは 1 つにまとめる', () => {
    const datasets = loadConfig(path.join(__dirname, '../integration/datasets.yaml'));
    const t = synth({}, datasets);
    const statement = Object.values(t.findResources('AWS::IAM::Policy'))[0].Properties.PolicyDocument.Statement[0];
    const arns = statement.Resource.map((r: { 'Fn::Join': [string, unknown[]] }) => (r['Fn::Join'][1] as unknown[]).at(-1));
    expect(arns).toContain(':dynamodb:ap-northeast-1:123456789012:table/t-gsi/index/byRoom');
    expect(arns.filter((a: string) => a.endsWith('table/t-epoch-ms'))).toHaveLength(1);
    expect(arns).toHaveLength(7);
  });
});

describe('-c cold=true（コールドストア）', () => {
  const coldSample = { room_temp: { ...sample.room_temp, cold: { type: 'athena' as const, hotRetention: '7d', maxRange: '400d' } } };
  const t = synth({ cold: 'true', coldScanLimitGb: '2' }, coldSample);

  it('S3 バケット: 名前にアカウント ID、公開ブロック、Athena の結果は 1 日で削除、既定は削除しない', () => {
    t.hasResource('AWS::S3::Bucket', {
      Properties: {
        BucketName: 'dynamodb-timeseries-api-cold-123456789012',
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        LifecycleConfiguration: { Rules: [Match.objectLike({ Prefix: 'athena-results/', ExpirationInDays: 1, Status: 'Enabled' })] },
      },
      DeletionPolicy: 'Retain',
    });
  });

  it('-c bucket_suffix でバケット名のサフィックスを変え、coldRemovalPolicy=destroy で中身ごと消す', () => {
    const d = synth({ cold: 'true', bucket_suffix: '20261110', coldRemovalPolicy: 'destroy' }, coldSample);
    d.hasResource('AWS::S3::Bucket', { Properties: { BucketName: 'dynamodb-timeseries-api-cold-20261110' }, DeletionPolicy: 'Delete' });
    d.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('Glue テーブル: Parquet、パーティション dataset / dt、パーティション射影', () => {
    t.hasResourceProperties('AWS::Glue::Database', { DatabaseInput: { Name: 'dynamodb_timeseries_api' } });
    t.hasResourceProperties('AWS::Glue::Table', {
      DatabaseName: 'dynamodb_timeseries_api',
      TableInput: Match.objectLike({
        Name: 'cold',
        PartitionKeys: [
          { Name: 'dataset', Type: 'string' },
          { Name: 'dt', Type: 'string' },
        ],
        Parameters: Match.objectLike({ 'projection.enabled': 'true', 'projection.dataset.type': 'injected', 'projection.dt.type': 'date' }),
      }),
    });
  });

  it('Athena ワークグループ: 1 回の読み込み量の上限（GB → バイト）を強制', () => {
    t.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: 'dynamodb-timeseries-api',
      WorkGroupConfiguration: Match.objectLike({ EnforceWorkGroupConfiguration: true, BytesScannedCutoffPerQuery: 2 * 1024 ** 3 }),
    });
  });

  it('Lambda に場所の環境変数と、ワークグループ・テーブルに限った権限', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { TSAPI_COLD_DATABASE: 'dynamodb_timeseries_api', TSAPI_COLD_TABLE: 'cold', TSAPI_COLD_WORKGROUP: 'dynamodb-timeseries-api' } },
    });
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('athena:StartQueryExecution');
    expect(policies).toContain('workgroup/dynamodb-timeseries-api');
    expect(policies).toContain('table/dynamodb_timeseries_api/cold');
    expect(policies).not.toContain('"athena:*"');
  });

  it('定期実行（既定の coldIngest=scheduled）: 取り込みの Lambda（15 分）と、毎日 01:00 UTC のスケジュール', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'dynamodb-timeseries-api-cold-ingest',
      Timeout: 900,
      Environment: { Variables: { TSAPI_COLD_BUCKET: Match.anyValue() } },
    });
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'dynamodb-timeseries-api-cold-ingest',
      ScheduleExpression: 'cron(0 1 * * ? *)',
      ScheduleExpressionTimezone: 'Etc/UTC',
    });
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('s3:DeleteObject');
  });

  it('cold を指定しなければ作らない', () => {
    const d = synth();
    d.resourceCountIs('AWS::S3::Bucket', 0);
    d.resourceCountIs('AWS::Athena::WorkGroup', 0);
    d.resourceCountIs('AWS::Scheduler::Schedule', 0);
  });
});

describe('-c cold=true -c coldIngest=stream', () => {
  const coldSample = { room_temp: { ...sample.room_temp, cold: { type: 'athena' as const, hotRetention: '7d', maxRange: '400d' } } };
  const t = synth({ cold: 'true', coldIngest: 'stream', sample: 'true' }, coldSample);

  it('サンプルテーブルのストリーム（新しいイメージ）を有効にし、INSERT だけを Lambda に渡す', () => {
    t.hasResourceProperties('AWS::DynamoDB::GlobalTable', { StreamSpecification: { StreamViewType: 'NEW_IMAGE' } });
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionName: Match.anyValue(),
      StartingPosition: 'LATEST',
      FilterCriteria: { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] },
    });
    t.resourceCountIs('AWS::Scheduler::Schedule', 0);
    t.resourceCountIs('Custom::AWS', 0); // サンプルテーブルのストリームは、作ったテーブルから直接参照する
  });

  it('Firehose: Parquet に変換し、dataset / dt で分けて data/ に書く', () => {
    t.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      DeliveryStreamName: 'dynamodb-timeseries-api-cold',
      ExtendedS3DestinationConfiguration: Match.objectLike({
        Prefix: 'data/dataset=!{partitionKeyFromQuery:dataset}/dt=!{partitionKeyFromQuery:dt}/',
        DynamicPartitioningConfiguration: Match.objectLike({ Enabled: true }),
        DataFormatConversionConfiguration: Match.objectLike({
          Enabled: true,
          SchemaConfiguration: Match.objectLike({ DatabaseName: 'dynamodb_timeseries_api', TableName: 'cold' }),
        }),
      }),
    });
  });

  it('既存のテーブル（サンプルでない）は、デプロイ時にストリームの ARN を読む', () => {
    const d = synth({ cold: 'true', coldIngest: 'stream' }, coldSample);
    d.resourceCountIs('Custom::AWS', 1);
    d.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });
});
