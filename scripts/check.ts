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
    console.log('  署名に使った認証情報に、API を呼ぶ権限があるか確かめてください（スタック出力の GrafanaPolicyArn のポリシー）');
    console.log('  関数 URL の場合は lambda:InvokeFunctionUrl（条件 lambda:FunctionUrlAuthType = AWS_IAM）が必要です');
  }
  if (r.status === 403 && auth.type === 'apiKey') console.log('  API キーが正しいか、使用量プランに紐づいているかを確かめてください');
  if (r.status === 500) console.log('  datasets.yaml のテーブル名・キー名・時刻形式が、実際のテーブルと合っているかを確かめてください');
  process.exit(1);
}

const target = await resolveTarget();
const get = createRequester(target);
console.log(`エンドポイント: ${target.endpoint}`);
console.log(`認証: ${describeAuth(target.auth)}`);
const ok = (r: ApiResponse, step: string) => {
  if (r.status !== 200) fail(step, r, target.auth);
  return r;
};

// 1. データセット一覧
const ds = ok(await get('datasets'), 'GET /datasets');
const names = (ds.body as { name: string }[]).map((d) => d.name);
console.log(`\nOK GET /datasets（${ds.ms}ms）: ${names.join(', ')}`);
const dataset = args.dataset ?? names[0];
if (!dataset) fail('GET /datasets', { status: ds.status, body: 'データセットが 1 つもありません' }, target.auth);

// 2. キー一覧
const ks = ok(await get('keys', { dataset }), 'GET /keys');
const keys = (ks.body as { key: string }[]).map((k) => k.key);
console.log(`OK GET /keys?dataset=${dataset}（${ks.ms}ms）: ${keys.length > 0 ? keys.join(', ') : '（なし。keys.values か keys.list を書くと一覧が出ます）'}`);
const key = args.key ?? keys[0];
if (!key) {
  console.log('\n--key を指定すると、時系列の取得も確かめます');
  process.exit(0);
}

// 3. 直近 1 時間の時系列（5 分ごとの平均）と最新値
type QueryBody = { rows: Record<string, unknown>[]; meta: { items: number; consumedRcu: number; truncated: boolean; truncatedBy?: string } };
const to = Date.now();
const q = ok(await get('query', { dataset, key, from: String(to - 3_600_000), to: String(to), interval: '5m', agg: 'avg' }), 'GET /query');
const { meta, rows } = q.body as QueryBody;
console.log(
  `OK GET /query 直近 1 時間・5 分平均（${q.ms}ms）: ${rows.length} 点、読んだ件数 ${meta.items}、消費 RCU ${meta.consumedRcu}${meta.truncated ? `、打ち切り（${meta.truncatedBy}）` : ''}`,
);
const latest = ok(await get('query', { dataset, key, from: String(to - 86_400_000), to: String(to), latest: '1' }), 'GET /query latest');
const row = (latest.body as QueryBody).rows[0];
console.log(
  `OK GET /query 最新値（${latest.ms}ms）: ${row ? `${new Date(row.time as number).toISOString()} ${JSON.stringify(row)}` : '直近 24 時間にデータがありません'}`,
);
if (rows.length === 0) console.log('\n直近 1 時間のデータがありません。pnpm seed でサンプルデータを入れるか、期間を確かめてください');
