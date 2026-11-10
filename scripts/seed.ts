// ---------------------------------------------------------------
// サンプルデータの投入
//   pnpm seed                       … cdk deploy -c sample=true で作ったテーブルに、7 日分を投入
//   pnpm seed --days 1 --rooms 2    … 期間と部屋数を変える
//   pnpm seed --create              … テーブルがなければ作る（DynamoDB Local で試すとき）
//   pnpm seed --cold-days 30        … さらに、その前の 30 日分をコールドストア（S3）に直接書く（datasets.yaml の cold と -c cold=true が必要）
// datasets.yaml のデータセットに cold があれば、DynamoDB のアイテムに TTL（expiresAt = hotRetention + 1 日）を付ける
// ---------------------------------------------------------------
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { selectColumns } from '../cdk/lambda/api/transform.ts';
import { writeDay } from '../cdk/lambda/ingest/day.ts';
import { rollup } from '../cdk/lambda/ingest/rollup.ts';
import { loadConfig } from '../cdk/lib/config.ts';
import { expiresAt, groupByUtcDay, itemsToRows } from './lib/cold.ts';
import { generateItems, roomIds } from './lib/seed-data.ts';
import { DEFAULT_STACK, getStackOutputs } from './lib/stack.ts';

const { values: args } = parseArgs({
  options: {
    table: { type: 'string', default: 'dynamodb-timeseries-api-sample' },
    days: { type: 'string', default: '7' },
    step: { type: 'string', default: '1' }, // 分
    rooms: { type: 'string', default: '3' },
    create: { type: 'boolean', default: false },
    'cold-days': { type: 'string', default: '0' },
    dataset: { type: 'string', default: 'room_temp' }, // TTL とコールドストアの列を決める datasets.yaml のデータセット
    config: { type: 'string', default: path.join(import.meta.dirname, '../config/datasets.yaml') },
    stack: { type: 'string', default: DEFAULT_STACK },
  },
});
const region = process.env.AWS_REGION ?? 'ap-northeast-1';
const dataset = loadConfig(path.resolve(args.config))[args.dataset];
if (!dataset) throw new Error(`Dataset ${args.dataset} is not in datasets.yaml`);
const table = args.table;
const raw = new DynamoDBClient({ region });
const doc = DynamoDBDocumentClient.from(raw);

async function ensureTable(): Promise<void> {
  try {
    await raw.send(new DescribeTableCommand({ TableName: table }));
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
    if (!args.create) throw new Error(`Table ${table} does not exist. Deploy with cdk deploy -c sample=true, or add --create for DynamoDB Local`);
    await raw.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'deviceId', AttributeType: 'S' },
          { AttributeName: 'ts', AttributeType: 'N' },
        ],
        KeySchema: [
          { AttributeName: 'deviceId', KeyType: 'HASH' },
          { AttributeName: 'ts', KeyType: 'RANGE' },
        ],
      }),
    );
    console.log(`Created table ${table}`);
  }
}

/** 25 件ずつ 8 並列で書き込む。処理されなかった分（UnprocessedItems）は待ってから書き直す */
async function writeAll(items: Record<string, unknown>[]): Promise<void> {
  type Put = { PutRequest: { Item: Record<string, unknown> } };
  const batches: Put[][] = [];
  for (let i = 0; i < items.length; i += 25) batches.push(items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })));
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < batches.length) {
        let requests = batches[next++];
        for (let attempt = 0; requests.length > 0; attempt++) {
          if (attempt > 0) await new Promise((ok) => setTimeout(ok, Math.min(100 * 2 ** attempt, 5000)));
          const r = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
          requests = (r.UnprocessedItems?.[table] ?? []) as Put[];
        }
        done += 25;
        if (done % 5000 === 0) console.log(`  ${done} / ${items.length}`);
      }
    }),
  );
}

/** 生成したデータの、さらに前の期間（UTC の日単位）を 1 分の集計にして S3 に書く */
async function writeCold(rooms: number, hotStart: number, coldDays: number): Promise<void> {
  if (!dataset.cold) throw new Error(`--cold-days requires cold on ${args.dataset} in datasets.yaml`);
  const bucket = (await getStackOutputs(args.stack, region)).ColdBucketName;
  if (!bucket) throw new Error(`The outputs of stack ${args.stack} have no ColdBucketName. Deploy with -c cold=true`);
  // 境界（hotStart）を含む日の終わりまでを書く（境界より後はホットから読むので、重なっても結果は変わらない）
  const end = Math.floor(hotStart / 86_400_000) * 86_400_000 + 86_400_000 - 1;
  const { items } = generateItems({ rooms, days: coldDays + 1, stepMs: Number(args.step) * 60_000, end });
  const columns = selectColumns(dataset, undefined);
  const days = [
    ...groupByUtcDay(
      itemsToRows(
        items.filter((i) => i.deviceId !== 'devices'),
        dataset,
      ),
    ),
  ].filter(([, rows]) => rows.length > 0);
  const s3 = new S3Client({ region });
  console.log(`Writing 1-minute rollups for ${days.length} days to s3://${bucket}/ (${days[0]?.[0]} to ${days.at(-1)?.[0]}, UTC)`);
  for (const [date, rows] of days) await writeDay({ s3, bucket }, args.dataset, date, rollup(rows, columns));
}

await ensureTable();
const rooms = Number(args.rooms);
const { items, start, end } = generateItems({ rooms, days: Number(args.days), stepMs: Number(args.step) * 60_000, end: Date.now() });
// 登録用アイテム（deviceId = devices）には TTL を付けない
// （lib-dynamodb は undefined の属性を書けないため、TTL がないときは属性を付けない）
for (const item of items) {
  const ttl = item.deviceId === 'devices' ? undefined : expiresAt(item.ts as number, dataset);
  if (ttl !== undefined) item.expiresAt = ttl;
}
const ttl = dataset.cold ? `, TTL ${dataset.cold.hotRetention} + 1 day` : '';
console.log(`Writing ${items.length} items to ${table} (${roomIds(rooms).join(', ')}, ${args.days} days, every ${args.step} minutes${ttl})`);
await writeAll(items);
console.log(`Done: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`);
if (Number(args['cold-days']) > 0) {
  await writeCold(rooms, start, Number(args['cold-days']));
  console.log('Finished writing to the cold storage');
}
