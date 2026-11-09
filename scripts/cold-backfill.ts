// ---------------------------------------------------------------
// 過去分をコールドストアに取り込む（DynamoDB に残っている期間が対象）
//   pnpm cold-backfill --days 7                         … 前日（UTC）から遡って 7 日分
//   pnpm cold-backfill --from 2026-11-01 --to 2026-11-05 --dataset room_temp
// 定期実行の Lambda と同じ処理（cdk/lambda/ingest/day.ts）を手元で実行する。同じ日を何度実行しても重複しない
// ---------------------------------------------------------------
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ingestDay, ingestKeys } from '../cdk/lambda/ingest/day.ts';
import { loadConfig } from '../cdk/lib/config.ts';
import { dateRange, lastDays } from './lib/cold.ts';
import { DEFAULT_STACK, getStackOutputs } from './lib/stack.ts';

const { values: args } = parseArgs({
  options: {
    days: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    dataset: { type: 'string', multiple: true }, // 省略すると cold を書いたデータセットすべて
    bucket: { type: 'string' }, // 省略するとスタックの出力（ColdBucketName）
    stack: { type: 'string', default: DEFAULT_STACK },
    region: { type: 'string', default: process.env.AWS_REGION ?? 'ap-northeast-1' },
    config: { type: 'string', default: path.join(import.meta.dirname, '../config/datasets.yaml') },
  },
});

const datasets = loadConfig(path.resolve(args.config));
const names = args.dataset ?? Object.keys(datasets).filter((n) => datasets[n].cold);
for (const n of names) if (!datasets[n]?.cold) throw new Error(`データセット ${n} がないか、cold が書かれていません`);
if (names.length === 0) throw new Error('cold を書いたデータセットがありません（config/datasets.yaml）');

let dates: string[];
if (args.from || args.to) dates = dateRange(args.from ?? args.to ?? '', args.to ?? args.from ?? '');
else dates = lastDays(Date.now(), Number(args.days ?? '7'));

const bucket = args.bucket ?? (await getStackOutputs(args.stack, args.region)).ColdBucketName;
if (!bucket) throw new Error(`スタック ${args.stack} の出力に ColdBucketName がありません。-c cold=true でデプロイしてください`);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }));
const s3 = new S3Client({ region: args.region });
console.log(`s3://${bucket}/ に ${names.join(', ')} の ${dates[0]} 〜 ${dates.at(-1)}（${dates.length} 日、UTC）を取り込みます`);
for (const name of names) {
  const keys = await ingestKeys(client, datasets[name]);
  for (const date of dates) {
    const r = await ingestDay(client, { s3, bucket }, name, datasets[name], date, keys);
    console.log(
      `  ${name} ${date}: キー ${r.keys}、読んだ件数 ${r.items}、1 分の集計 ${r.records} 行、${(r.bytes / 1024).toFixed(1)}KB、消費 RCU ${r.consumedRcu}`,
    );
  }
}
console.log('完了しました');
