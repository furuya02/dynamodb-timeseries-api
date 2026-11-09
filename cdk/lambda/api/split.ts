// ---------------------------------------------------------------
// 問い合わせの範囲を、ホット（DynamoDB）とコールド（S3 + Athena）に分ける
// ---------------------------------------------------------------
import { COLD_STEP_MS } from './cold/sql';
import { parseDuration } from './time';
import type { QueryRequest } from './types';

export interface Range {
  from: number;
  to: number;
}

export interface Split {
  hot?: Range;
  cold?: Range;
}

/**
 * 境界 = 現在 − hotRetention（1 分単位に切り捨て）。境界より前をコールド、境界以降をホットから読む。
 * 境界をまたぐ区切りは、両方の途中集計を足し合わせるので、境界を区切りにそろえる必要はない。
 * DynamoDB の TTL は hotRetention より長く取り、境界以降のデータが消えていないようにする
 */
export function splitRange(req: QueryRequest, now: number): Split {
  const retention = req.dataset.cold ? parseDuration(req.dataset.cold.hotRetention) : undefined;
  if (retention === undefined) return { hot: { from: req.from, to: req.to } };
  const boundary = Math.floor((now - retention) / COLD_STEP_MS) * COLD_STEP_MS;
  if (req.from >= boundary) return { hot: { from: req.from, to: req.to } };
  if (req.to < boundary) return { cold: { from: req.from, to: req.to } };
  return { cold: { from: req.from, to: boundary - 1 }, hot: { from: boundary, to: req.to } };
}
