// ---------------------------------------------------------------
// データセット定義の雛形を作る
//   pnpm init-dataset --table iot-metrics                 … datasets.yaml に貼る下書きを表示
//   pnpm init-dataset --table iot-metrics --index byRoom  … GSI を使う場合
// DescribeTable でキーを調べ、先頭の 100 件（--sample）だけを読んで、時刻形式や属性を推定する（数 RCU 程度）
// ---------------------------------------------------------------
import { parseArgs } from 'node:util';
import { DescribeTableCommand, DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { stringify } from 'yaml';
import { inferDataset } from './lib/infer.ts';

const { values: args } = parseArgs({
  options: {
    table: { type: 'string' },
    index: { type: 'string' },
    name: { type: 'string' },
    sample: { type: 'string', default: '100' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const table = args.table ?? fail('Usage: pnpm init-dataset --table <table name> [--index <GSI name>] [--name <dataset name>] [--sample 100]');
const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
const desc = (await client.send(new DescribeTableCommand({ TableName: table }))).Table;
const keySchema = args.index ? desc?.GlobalSecondaryIndexes?.find((g) => g.IndexName === args.index)?.KeySchema : desc?.KeySchema;
if (!keySchema) fail(`Index ${args.index} does not exist on table ${table}`);
const partitionKey = keySchema.find((k) => k.KeyType === 'HASH')?.AttributeName ?? fail('Partition key not found');
const sortKey = keySchema.find((k) => k.KeyType === 'RANGE')?.AttributeName ?? fail('A table (index) without a sort key cannot be used as time series');

const items = (await client.send(new ScanCommand({ TableName: table, IndexName: args.index, Limit: Number(args.sample) }))).Items ?? [];
if (items.length === 0) fail('Cannot infer anything because the table has no items');

const result = inferDataset({
  table,
  index: args.index,
  name: args.name,
  partitionKey,
  sortKey,
  tableKeys: (desc?.KeySchema ?? []).map((k) => k.AttributeName ?? ''),
  items,
});
console.log(`# pnpm init-dataset --table ${table}${args.index ? ` --index ${args.index}` : ''} result (inferred from the first ${items.length} items)`);
console.log('# Paste this under datasets: in config/datasets.yaml and review it before use');
for (const n of result.notes) console.log(`# check: ${n}`);
console.log(
  stringify({ [result.name]: result.dataset }, { flowCollectionPadding: true })
    .replace(/^/gm, '  ')
    .trimEnd(),
);
