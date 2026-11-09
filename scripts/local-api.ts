// ---------------------------------------------------------------
// API をローカルで動かす（AWS にデプロイせずに試すとき、開発用）
//   AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000 pnpm local-api   … DynamoDB Local を読む
//   pnpm local-api --port 13000 --config ../config/datasets.yaml
// Lambda と同じ処理（cdk/lambda/api/app.ts）を、認証なしの HTTP サーバーで呼ぶ
// ---------------------------------------------------------------
import { createServer } from 'node:http';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createApi } from '../cdk/lambda/api/app.ts';
import { ConfigError, loadConfig } from '../cdk/lib/config.ts';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '13000' }, // Grafana（3000）と重ならないように。pnpm grafana-config --local の既定と同じ
    host: { type: 'string', default: '0.0.0.0' }, // Docker の Grafana から host.docker.internal で呼べるように
    config: { type: 'string', default: path.join(import.meta.dirname, '../config/datasets.yaml') },
  },
});

let datasets: ReturnType<typeof loadConfig>;
try {
  datasets = loadConfig(path.resolve(args.config));
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
const api = createApi({ datasets, client: DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' })) });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { status, body, headers } = await api.handle(url.pathname, Object.fromEntries(url.searchParams));
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}).listen(Number(args.port), args.host, () => {
  console.error(`http://localhost:${args.port}/ で待ち受けています（datasets: ${Object.keys(datasets).join(', ')}）`);
  console.error(`DynamoDB: ${process.env.AWS_ENDPOINT_URL_DYNAMODB ?? 'AWS（環境の認証情報）'}`);
});
