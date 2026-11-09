import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildDatasourceConfig } from '../lib/grafana.ts';

const datasourceOf = (yaml: string) => parse(yaml).datasources[0];

describe('buildDatasourceConfig', () => {
  it('--local: host.docker.internal の local-api に認証なしで向ける', () => {
    const c = buildDatasourceConfig({ kind: 'local', port: 13000 });
    expect(c.yaml.startsWith('# pnpm grafana-config --local で生成')).toBe(true);
    expect(datasourceOf(c.yaml)).toEqual({
      name: 'dynamodb-timeseries-api',
      uid: 'tsapi',
      type: 'yesoreyeram-infinity-datasource',
      url: 'http://host.docker.internal:13000/',
      jsonData: {
        auth_method: 'none',
        timeoutInSeconds: 30,
        customHealthCheckEnabled: true,
        customHealthCheckUrl: 'http://host.docker.internal:13000/datasets',
      },
      editable: true,
    });
  });

  it('REST API + IAM: SigV4（execute-api）、キーは環境変数から読む', () => {
    const c = buildDatasourceConfig({
      kind: 'stack',
      region: 'us-east-1',
      outputs: {
        Endpoint: 'https://abc.execute-api.ap-northeast-1.amazonaws.com/v1/',
        Region: 'ap-northeast-1',
        CreateAccessKeyCommand: 'aws iam create-access-key --user-name u',
      },
    });
    const ds = datasourceOf(c.yaml);
    expect(ds.jsonData).toMatchObject({ auth_method: 'aws', aws: { authType: 'keys', region: 'ap-northeast-1', service: 'execute-api' } });
    expect(ds.secureJsonData).toEqual({ awsAccessKey: '$__env{TSAPI_AWS_ACCESS_KEY_ID}', awsSecretKey: '$__env{TSAPI_AWS_SECRET_ACCESS_KEY}' });
    expect(c.howTo.join('\n')).toContain('aws iam create-access-key --user-name u');
  });

  it('関数 URL + IAM: サービス名は lambda、末尾の / を補う', () => {
    const c = buildDatasourceConfig({ kind: 'stack', region: 'ap-northeast-1', outputs: { Endpoint: 'https://xyz.lambda-url.ap-northeast-1.on.aws' } });
    expect(c.url).toBe('https://xyz.lambda-url.ap-northeast-1.on.aws/');
    expect(datasourceOf(c.yaml).jsonData.aws.service).toBe('lambda');
  });

  it('API キー: x-api-key ヘッダー、値は環境変数 TSAPI_API_KEY から', () => {
    const cmd = 'aws apigateway get-api-key --api-key k1 --include-value --query value --output text';
    const c = buildDatasourceConfig({
      kind: 'stack',
      region: 'ap-northeast-1',
      outputs: { Endpoint: 'https://abc.execute-api.ap-northeast-1.amazonaws.com/v1/', GetApiKeyCommand: cmd },
    });
    const ds = datasourceOf(c.yaml);
    expect(ds.jsonData).toMatchObject({ auth_method: 'apiKey', apiKeyKey: 'x-api-key', apiKeyType: 'header' });
    expect(ds.secureJsonData).toEqual({ apiKeyValue: '$__env{TSAPI_API_KEY}' });
    expect(c.howTo).toContain(`  export TSAPI_API_KEY=$(${cmd})`);
  });
});
