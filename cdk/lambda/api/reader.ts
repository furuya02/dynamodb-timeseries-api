// ---------------------------------------------------------------
// DynamoDB の読み込み（Query API のページング、並列実行、上限による打ち切り）
// ---------------------------------------------------------------
import { QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { partitionValues, readTime, sortRange } from './key-condition';
import { compareRows } from './rows';
import { projection, toValues } from './transform';
import type { QueryRequest, ReadMeta, ReadResult, Row, TruncatedBy } from './types';

/** Query を送るクライアント（DynamoDBDocumentClient。テストでは差し替える） */
export interface QueryClient {
  send(command: QueryCommand): Promise<QueryCommandOutput>;
}

/** 同時に投げる Query の数 */
export const CONCURRENCY = 8;
/** latest=1 のときの 1 ページの件数。範囲外（ISO 8601 で to と同じ秒の後ろ）の数件を読み飛ばせれば足りる */
const LATEST_PAGE_SIZE = 10;

/**
 * キー × 日付の Query を並列に実行し、範囲内のアイテムを行にする。
 * - 次のページを読む前に maxItems / maxPages / maxRcu を確かめ、超えていれば打ち切る（読んだ分は返す）
 * - latest のときは、キーごとに新しい日付から降順に読み、範囲内の 1 件が見つかった時点で止める
 */
export async function readRows(client: QueryClient, req: QueryRequest): Promise<ReadResult> {
  const { dataset: d, from, to } = req;
  const [lo, hi] = sortRange(d, from, to);
  const proj = projection(d.sortKey.name, req.columns);
  const meta: ReadMeta = { queries: 0, pages: 0, items: 0, truncated: false, consumedRcu: 0 };
  const rows: Row[] = [];

  const limitReached = (): TruncatedBy | undefined => {
    if (meta.items >= d.limits.maxItems) return 'maxItems';
    if (meta.pages >= d.limits.maxPages) return 'maxPages';
    if (meta.consumedRcu >= d.limits.maxRcu) return 'maxRcu';
    return undefined;
  };

  /** 1 つのパーティションキーを読む。latest で 1 件見つかったら true */
  const readPartition = async (key: string, pkValue: string): Promise<boolean> => {
    meta.queries++;
    let start: Record<string, unknown> | undefined;
    do {
      const by = limitReached();
      if (by) {
        meta.truncated = true;
        meta.truncatedBy ??= by;
        return false;
      }
      meta.pages++;
      const r = await client.send(
        new QueryCommand({
          TableName: d.table,
          IndexName: d.index,
          KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
          ProjectionExpression: proj.expression,
          ExpressionAttributeNames: { '#pk': d.partitionKey.name, ...proj.names },
          ExpressionAttributeValues: { ':pk': pkValue, ':lo': lo, ':hi': hi },
          ScanIndexForward: !req.latest,
          Limit: req.latest ? LATEST_PAGE_SIZE : d.limits.maxItems - meta.items,
          ExclusiveStartKey: start,
          ReturnConsumedCapacity: 'TOTAL',
        }),
      );
      meta.consumedRcu += r.ConsumedCapacity?.CapacityUnits ?? 0;
      for (const item of r.Items ?? []) {
        meta.items++;
        const time = readTime(d, item[d.sortKey.name]);
        if (!(time >= from && time <= to)) continue; // 範囲外と、時刻として読めない値（NaN）を除く
        rows.push({ time, key, values: toValues(item, req.columns) });
        if (req.latest) return true;
      }
      start = r.LastEvaluatedKey;
    } while (start);
    return false;
  };

  const tasks: (() => Promise<unknown>)[] = req.latest
    ? req.keys.map((key) => async () => {
        for (const pk of partitionValues(d, key, from, to).reverse()) if (await readPartition(key, pk)) return;
      })
    : req.keys.flatMap((key) => partitionValues(d, key, from, to).map((pk) => () => readPartition(key, pk)));
  await runWithConcurrency(tasks, CONCURRENCY);

  rows.sort(compareRows);
  return { rows, meta };
}

/** tasks を同時に limit 個までで実行する */
export async function runWithConcurrency(tasks: (() => Promise<unknown>)[], limit: number): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) await tasks[next++]();
    }),
  );
}
