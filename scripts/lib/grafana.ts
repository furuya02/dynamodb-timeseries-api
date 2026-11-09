// ---------------------------------------------------------------
// Grafana（Infinity）のデータソース設定（provisioning）を作る
// アクセスキーや API キーの値はファイルに書かず、Grafana の起動時に環境変数から読む（$__env{...}）
// ---------------------------------------------------------------
import { stringify } from 'yaml';
import type { StackOutputs } from './stack.ts';
import { isFunctionUrl, withTrailingSlash } from './target.ts';

/** サンプルダッシュボードとアラートルールは、この UID でデータソースを参照する */
export const DATASOURCE_UID = 'tsapi';
export const DATASOURCE_NAME = 'dynamodb-timeseries-api';

export type DatasourceSource = { kind: 'local'; port: number } | { kind: 'stack'; outputs: StackOutputs; region: string };

export interface DatasourceConfig {
  url: string;
  /** provisioning の YAML（先頭にコメントつき） */
  yaml: string;
  /** Grafana を起動する前に必要な手順 */
  howTo: string[];
}

export function buildDatasourceConfig(source: DatasourceSource): DatasourceConfig {
  let url: string;
  let jsonData: Record<string, unknown>;
  let secureJsonData: Record<string, string> | undefined;
  let howTo: string[];

  if (source.kind === 'local') {
    // Docker の中の Grafana から、ホストで動く pnpm local-api を呼ぶ
    url = `http://host.docker.internal:${source.port}/`;
    jsonData = { auth_method: 'none' };
    howTo = [`別のターミナルで pnpm local-api --port ${source.port} を起動しておいてください`];
  } else {
    const { outputs } = source;
    url = withTrailingSlash(outputs.Endpoint ?? '');
    if (outputs.GetApiKeyCommand) {
      jsonData = { auth_method: 'apiKey', apiKeyKey: 'x-api-key', apiKeyType: 'header' };
      secureJsonData = { apiKeyValue: '$__env{TSAPI_API_KEY}' };
      howTo = ['API キーを環境変数 TSAPI_API_KEY に入れてから Grafana を起動してください', `  export TSAPI_API_KEY=$(${outputs.GetApiKeyCommand})`];
    } else {
      // IAM 認証: Infinity が SigV4 で署名する。Infinity の service の既定は monitoring なので必ず指定する
      jsonData = {
        auth_method: 'aws',
        aws: { authType: 'keys', region: outputs.Region ?? source.region, service: isFunctionUrl(url) ? 'lambda' : 'execute-api' },
      };
      secureJsonData = { awsAccessKey: '$__env{TSAPI_AWS_ACCESS_KEY_ID}', awsSecretKey: '$__env{TSAPI_AWS_SECRET_ACCESS_KEY}' };
      howTo = [
        'Grafana 用 IAM ユーザーのアクセスキーを環境変数に入れてから Grafana を起動してください',
        outputs.CreateAccessKeyCommand
          ? `  キーの作成: ${outputs.CreateAccessKeyCommand}`
          : '  （-c grafanaUser=true でデプロイすると、Grafana 用 IAM ユーザーが作られます）',
        '  export TSAPI_AWS_ACCESS_KEY_ID=AKIA...',
        '  export TSAPI_AWS_SECRET_ACCESS_KEY=...',
      ];
    }
  }

  const config = {
    apiVersion: 1,
    datasources: [
      {
        name: DATASOURCE_NAME,
        uid: DATASOURCE_UID,
        type: 'yesoreyeram-infinity-datasource',
        // ベース URL を設定すると、クエリの URL（query / keys など）はこの後ろにつながる
        url,
        jsonData: {
          ...jsonData,
          timeoutInSeconds: 30,
          // データソースの「Save & test」で /datasets を呼んで確かめる
          customHealthCheckEnabled: true,
          customHealthCheckUrl: `${url}datasets`,
        },
        ...(secureJsonData ? { secureJsonData } : {}),
        editable: true,
      },
    ],
  };
  const command = source.kind === 'local' ? 'pnpm grafana-config --local' : 'pnpm grafana-config';
  return { url, yaml: `# ${command} で生成（手で編集しないでください）\n${stringify(config)}`, howTo };
}
