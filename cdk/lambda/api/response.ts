// ---------------------------------------------------------------
// /query の応答の組み立て
// ---------------------------------------------------------------
import { addBuckets, addRows, finalize, shape } from './aggregate';
import type { ColdResult } from './cold/reader';
import { COLD_STEP_MS } from './cold/sql';
import { ApiError } from './errors';
import { compareRows } from './rows';
import type { QueryRequest, ReadMeta, ReadResult, Row } from './types';

/** Lambda の同期呼び出しの応答上限（6MB）に余裕を持たせた値 */
export const MAX_RESPONSE_BYTES = 5_500_000;

const EMPTY_READ: ReadMeta = { queries: 0, pages: 0, items: 0, truncated: false, consumedRcu: 0 };

/**
 * 応答。Infinity では rows を行として読む（Rows / Root に rows を指定）。
 * columns は列の型と単位、meta は打ち切り（truncated）や消費 RCU の確認用。
 * hot は DynamoDB、cold はコールドストア（S3 + Athena）から読んだ結果で、同じ区切りの値は足し合わせて 1 本の系列にする
 */
export function toResponse(req: QueryRequest, hot: ReadResult | undefined, cold?: ColdResult) {
  const rows = mergeRows(req, hot?.rows ?? [], cold);
  const counted = req.interval !== undefined && req.agg === 'count';
  const read = hot?.meta ?? EMPTY_READ;
  const truncated = read.truncated || (cold?.meta.truncated ?? false);
  return {
    rows: shape(rows, req.format),
    columns: req.columns.map((c) => ({
      name: c.column,
      type: counted ? 'number' : c.field.type,
      unit: counted ? undefined : c.field.unit,
    })),
    meta: {
      dataset: req.name,
      ...read,
      truncated,
      truncatedBy: read.truncatedBy ?? (cold?.meta.truncated ? ('maxItems' as const) : undefined),
      points: rows.length,
      interval: req.interval,
      agg: req.interval === undefined ? undefined : req.agg,
      cold: cold?.meta,
    },
  };
}

function mergeRows(req: QueryRequest, hot: Row[], cold: ColdResult | undefined): Row[] {
  if (req.latest) {
    // ホットで見つからなかったキーだけ、コールドの最新値を使う
    const found = new Set(hot.map((r) => r.key));
    return [...hot, ...(cold?.rows.filter((r) => !found.has(r.key)) ?? [])].sort(compareRows);
  }
  if (req.interval === undefined) {
    if (!cold) return hot;
    // 生データの問い合わせでも、コールドの範囲は 1 分の平均（数値以外は最後の値）を返す
    const coldRows = finalize(addBuckets(new Map(), cold.buckets, req.columns, COLD_STEP_MS, 'UTC'), req.columns, 'avg');
    return [...coldRows, ...hot].sort(compareRows);
  }
  const buckets = addRows(new Map(), hot, req.columns, req.interval, req.tz);
  if (cold) addBuckets(buckets, cold.buckets, req.columns, req.interval, req.tz);
  return finalize(buckets, req.columns, req.agg);
}

export type QueryResponse = ReturnType<typeof toResponse>;

/**
 * 応答の大きさ（バイト数）を確かめる。
 * 上限を超えると API Gateway が 502 になり理由がわからないため、手前で理由つきの 400 にする
 */
export function measureResponse(body: QueryResponse, maxBytes = MAX_RESPONSE_BYTES): number {
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > maxBytes) {
    throw new ApiError(
      400,
      `The response is too large (${(bytes / 1e6).toFixed(1)} MB, limit ${maxBytes / 1e6} MB). Aggregate with interval, shorten the time range, or reduce the columns with fields`,
    );
  }
  return bytes;
}
