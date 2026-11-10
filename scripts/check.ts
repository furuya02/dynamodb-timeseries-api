// ---------------------------------------------------------------
// 接続確認（Grafana を使わずに API の応答を確かめる）
//   pnpm check                                   … CloudFormation の出力からエンドポイントと認証方式を読む
//   pnpm check --dataset room_temp --key room-01 … 確かめるデータセットとキーを指定
//   pnpm check --endpoint http://localhost:13000/ … pnpm local-api を呼ぶ（署名なし）
// ---------------------------------------------------------------
import { parseArgs } from 'node:util';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { type ApiResponse, createRequester } from './lib/http.ts';
import { apiKeyIdOf, DEFAULT_STACK, getStackOutputs } from './lib/stack.ts';
import { type Auth, describeAuth, resolveAuth, withTrailingSlash } from './lib/target.ts';

const { values: args } = parseArgs({
  options: {
    stack: { type: 'string', default: DEFAULT_STACK },
    region: { type: 'string', default: process.env.AWS_REGION ?? 'ap-northeast-1' },
    endpoint: { type: 'string' },
    'api-key': { type: 'string' },
    dataset: { type: 'string' },
    key: { type: 'string' },
  },
});

/** エンドポイントと認証方式。--endpoint がなければスタックの出力から読み、API キー認証ならキーの値を取得する */
async function resolveTarget(): Promise<{ endpoint: string; auth: Auth }> {
  let endpoint = args.endpoint;
  let region = args.region;
  let apiKey = args['api-key'];
  if (!endpoint) {
    const outputs = await getStackOutputs(args.stack, region);
    endpoint = outputs.Endpoint ?? '';
    region = outputs.Region ?? region;
    const keyId = apiKeyIdOf(outputs);
    if (keyId && !apiKey) apiKey = (await new APIGatewayClient({ region }).send(new GetApiKeyCommand({ apiKey: keyId, includeValue: true }))).value;
  }
  endpoint = withTrailingSlash(endpoint);
  return { endpoint, auth: resolveAuth(endpoint, region, apiKey) };
}

function fail(step: string, r: { status: number; body: unknown }, auth: Auth): never {
  console.log(`\nNG ${step}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.status === 403 && auth.type === 'iam') {
    console.log('  Check that the credentials used for signing can call the API (the GrafanaPolicyArn policy in the stack outputs)');
    console.log('  For a function URL, lambda:InvokeFunctionUrl (condition lambda:FunctionUrlAuthType = AWS_IAM) is required');
  }
  if (r.status === 403 && auth.type === 'apiKey') console.log('  Check that the API key is correct and associated with the usage plan');
  if (r.status === 500) console.log('  Check that the table name, key names, and time format in datasets.yaml match the actual table');
  process.exit(1);
}

const target = await resolveTarget();
const get = createRequester(target);
console.log(`Endpoint: ${target.endpoint}`);
console.log(`Auth: ${describeAuth(target.auth)}`);
const ok = (r: ApiResponse, step: string) => {
  if (r.status !== 200) fail(step, r, target.auth);
  return r;
};

// 1. データセット一覧
const ds = ok(await get('datasets'), 'GET /datasets');
const names = (ds.body as { name: string }[]).map((d) => d.name);
console.log(`\nOK GET /datasets（${ds.ms}ms）: ${names.join(', ')}`);
const dataset = args.dataset ?? names[0];
if (!dataset) fail('GET /datasets', { status: ds.status, body: 'No datasets are defined' }, target.auth);

// 2. キー一覧
const ks = ok(await get('keys', { dataset }), 'GET /keys');
const keys = (ks.body as { key: string }[]).map((k) => k.key);
console.log(`OK GET /keys?dataset=${dataset} (${ks.ms}ms): ${keys.length > 0 ? keys.join(', ') : '(none; add keys.values or keys.list to get a list)'}`);
const key = args.key ?? keys[0];
if (!key) {
  console.log('\nSpecify --key to also check a time-series query');
  process.exit(0);
}

// 3. 直近 1 時間の時系列（5 分ごとの平均）と最新値
type QueryBody = { rows: Record<string, unknown>[]; meta: { items: number; consumedRcu: number; truncated: boolean; truncatedBy?: string } };
const to = Date.now();
const q = ok(await get('query', { dataset, key, from: String(to - 3_600_000), to: String(to), interval: '5m', agg: 'avg' }), 'GET /query');
const { meta, rows } = q.body as QueryBody;
console.log(
  `OK GET /query last 1 hour, 5-minute average (${q.ms}ms): ${rows.length} points, items read ${meta.items}, consumed RCU ${meta.consumedRcu}${meta.truncated ? `, truncated (${meta.truncatedBy})` : ''}`,
);
const latest = ok(await get('query', { dataset, key, from: String(to - 86_400_000), to: String(to), latest: '1' }), 'GET /query latest');
const row = (latest.body as QueryBody).rows[0];
console.log(
  `OK GET /query latest value (${latest.ms}ms): ${row ? `${new Date(row.time as number).toISOString()} ${JSON.stringify(row)}` : 'no data in the last 24 hours'}`,
);
if (rows.length === 0) console.log('\nNo data in the last hour. Load sample data with pnpm seed, or check the time range');
