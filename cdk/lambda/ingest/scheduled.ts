// ---------------------------------------------------------------
// 定期実行（-c coldIngest=scheduled）の Lambda の入口
// EventBridge Scheduler から 1 日 1 回呼ばれ、cold を設定したデータセットの前日分（UTC）を取り込む
// 手動で呼ぶとき: {"date": "2026-11-01", "datasets": ["room_temp"]}
// ---------------------------------------------------------------
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { writeLog } from '../api/app';
import generated from '../api/datasets.generated.json';
import type { Datasets } from '../api/types';
import { ingestDay } from './day';
import { yesterday } from './scheduled-date';

const datasets: Datasets = generated;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

export interface IngestEvent {
  date?: string;
  datasets?: string[];
}

export const handler = async (event: IngestEvent = {}): Promise<unknown[]> => {
  const bucket = process.env.TSAPI_COLD_BUCKET as string;
  const date = event.date ?? yesterday(Date.now());
  const names = event.datasets ?? Object.keys(datasets).filter((n) => datasets[n].cold);
  const results = [];
  for (const name of names) {
    const started = Date.now();
    const r = await ingestDay(client, { s3, bucket }, name, datasets[name], date);
    writeLog({ type: 'ingest', ...r, durationMs: Date.now() - started });
    results.push(r);
  }
  return results;
};
