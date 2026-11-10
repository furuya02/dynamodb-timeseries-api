// ---------------------------------------------------------------
// コールドストアの取り込み用の小さな計算（日付の列挙、アイテム → 行、TTL）
// ---------------------------------------------------------------

import { parseDuration } from '../../cdk/lambda/api/time.ts';
import { selectColumns, toValues } from '../../cdk/lambda/api/transform.ts';
import type { Row } from '../../cdk/lambda/api/types.ts';
import type { ResolvedDataset } from '../../cdk/lib/config.ts';

const DAY = 86_400_000;
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** from〜to（yyyy-MM-dd、両端を含む）の日付を古い順に */
export function dateRange(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) throw new Error(`Invalid date range: ${from} to ${to} (yyyy-MM-dd)`);
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY) out.push(utcDate(t));
  return out;
}

/** 前日（UTC）から遡って days 日分の日付を古い順に */
export const lastDays = (now: number, days: number): string[] => dateRange(utcDate(now - days * DAY), utcDate(now - DAY));

/** テーブルのアイテムを行にする（パーティションキーの値をそのままキーとして使う、単純な設計のテーブル向け） */
export function itemsToRows(items: Record<string, unknown>[], d: ResolvedDataset): Row[] {
  const columns = selectColumns(d, undefined);
  return items.map((item) => ({ time: Number(item[d.sortKey.name]), key: String(item[d.partitionKey.name]), values: toValues(item, columns) }));
}

/** UTC の日付ごとに分ける */
export function groupByUtcDay(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const day = utcDate(r.time);
    const list = out.get(day);
    if (list) list.push(r);
    else out.set(day, [r]);
  }
  return out;
}

/** DynamoDB の TTL（UNIX 秒）。hotRetention + 1 日後に消す（境界の手前まで DynamoDB に残す） */
export function expiresAt(ts: number, d: ResolvedDataset): number | undefined {
  const retention = d.cold ? parseDuration(d.cold.hotRetention) : undefined;
  return retention === undefined ? undefined : Math.floor((ts + retention + DAY) / 1000);
}
