// ---------------------------------------------------------------
// ストリーム（-c coldIngest=stream）の Lambda の入口
// DynamoDB Streams の INSERT を 1 分の集計にして Firehose に送る。Firehose が Parquet に変換し、データセット・日付ごとに S3 に書く。
// 同じ 1 分が複数のバッチに分かれても、Athena で件数・合計などを足し合わせるため結果は変わらない
// ---------------------------------------------------------------
import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { writeLog } from '../api/app';
import generated from '../api/datasets.generated.json';
import type { Datasets } from '../api/types';
import { datasetsByTable, toFirehoseRecords } from './stream-match';

const datasets: Datasets = generated;
const byTable = datasetsByTable(datasets);
const firehose = new FirehoseClient({});
/** PutRecordBatch の 1 回の上限は 500 件 */
const BATCH = 500;

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  const records = toFirehoseRecords(datasets, byTable, event);
  for (let i = 0; i < records.length; i += BATCH) {
    let pending = records.slice(i, i + BATCH);
    // 一部だけ失敗した分（FailedPutCount）は送り直す。送れなければ例外にして、Lambda にバッチごと再試行させる
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= 3) throw new Error(`Failed to send ${pending.length} records to Firehose`);
      const r = await firehose.send(
        new PutRecordBatchCommand({
          DeliveryStreamName: process.env.TSAPI_COLD_FIREHOSE,
          Records: pending.map((x) => ({ Data: Buffer.from(`${JSON.stringify(x)}\n`) })),
        }),
      );
      pending = pending.filter((_, j) => r.RequestResponses?.[j]?.ErrorCode);
    }
  }
  writeLog({ type: 'stream', records: event.Records.length, rollups: records.length });
};
