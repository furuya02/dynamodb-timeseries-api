// ---------------------------------------------------------------
// Grafana のデータソース設定（provisioning）を作る
//   pnpm grafana-config            … デプロイしたスタックの出力（エンドポイント、リージョン、認証方式）から作る
//   pnpm grafana-config --local    … pnpm local-api（認証なし）に向けた設定を作る
// 出力: grafana/provisioning/generated/datasources/dynamodb-timeseries-api.yaml
// ---------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { buildDatasourceConfig } from './lib/grafana.ts';
import { DEFAULT_STACK, getStackOutputs } from './lib/stack.ts';

const { values: args } = parseArgs({
  options: {
    stack: { type: 'string', default: DEFAULT_STACK },
    region: { type: 'string', default: process.env.AWS_REGION ?? 'ap-northeast-1' },
    local: { type: 'boolean', default: false },
    port: { type: 'string', default: '13000' },
  },
});

const config = buildDatasourceConfig(
  args.local ? { kind: 'local', port: Number(args.port) } : { kind: 'stack', outputs: await getStackOutputs(args.stack, args.region), region: args.region },
);
const root = path.join(import.meta.dirname, '..');
const file = path.join(root, 'grafana/provisioning/generated/datasources/dynamodb-timeseries-api.yaml');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, config.yaml);
console.log(`Created ${path.relative(root, file)} (${config.url})`);
for (const line of config.howTo) console.log(line);
console.log('Start: pnpm grafana-up → http://localhost:3000/');
