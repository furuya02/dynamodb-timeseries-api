// ---------------------------------------------------------------
// ダウンサンプリング（集計）と出力形式
// ---------------------------------------------------------------
import { compareRows } from './rows';
import { bucketStart } from './time';
import { round } from './transform';
import type { Agg, Column, Format, Row } from './types';

/**
 * 1 つの区切り・1 列分の途中集計。足し合わせられる形なので、DynamoDB の行とコールドストアの集計済みの行を同じ区切りでまとめられる。
 * 数値以外の列は cnt と last だけを使う
 */
export interface Partial {
  cnt: number;
  sum: number;
  min: number;
  max: number;
  last: unknown;
  /** last の時刻（同じ時刻なら後から足した方を残す） */
  lastTs: number;
}

/** キー × 区切りごとの途中集計 */
export interface Bucket {
  time: number;
  key: string;
  values: Record<string, Partial>;
}

export type Buckets = Map<string, Bucket>;

export const emptyPartial = (): Partial => ({
  cnt: 0,
  sum: 0,
  min: Number.POSITIVE_INFINITY,
  max: Number.NEGATIVE_INFINITY,
  last: null,
  lastTs: Number.NEGATIVE_INFINITY,
});

export function mergePartial(into: Partial, p: Partial): void {
  if (p.cnt === 0) return;
  into.cnt += p.cnt;
  into.sum += p.sum;
  into.min = Math.min(into.min, p.min);
  into.max = Math.max(into.max, p.max);
  if (p.lastTs >= into.lastTs) {
    into.last = p.last;
    into.lastTs = p.lastTs;
  }
}

/** 区切りを取り出す（なければ作る）。time は tz の壁時計で区切り直す */
function bucketOf(buckets: Buckets, time: number, key: string, columns: Column[], interval: number, tz: string): Bucket {
  const start = bucketStart(time, interval, tz);
  const id = `${key}\u0000${start}`;
  let b = buckets.get(id);
  if (!b) {
    b = { time: start, key, values: Object.fromEntries(columns.map((c) => [c.column, emptyPartial()])) };
    buckets.set(id, b);
  }
  return b;
}

/** 行（DynamoDB のアイテム）を途中集計に加える。欠損（null）は除く */
export function addRows(buckets: Buckets, rows: Row[], columns: Column[], interval: number, tz: string): Buckets {
  for (const r of rows) {
    const b = bucketOf(buckets, r.time, r.key, columns, interval, tz);
    for (const { column, field } of columns) {
      const v = r.values[column];
      if (v === null || v === undefined) continue;
      const n = field.type === 'number' ? (v as number) : 0;
      mergePartial(b.values[column], { cnt: 1, sum: n, min: n, max: n, last: v, lastTs: r.time });
    }
  }
  return buckets;
}

/** 集計済みの区切り（コールドストアの行）を途中集計に加える */
export function addBuckets(buckets: Buckets, from: Bucket[], columns: Column[], interval: number, tz: string): Buckets {
  for (const f of from) {
    const b = bucketOf(buckets, f.time, f.key, columns, interval, tz);
    for (const { column } of columns) if (f.values[column]) mergePartial(b.values[column], f.values[column]);
  }
  return buckets;
}

/** 途中集計を agg の値にする。数値以外の列は avg / min / max / sum のとき最後の値を返す。count は列の型に関係なく件数 */
export function finalize(buckets: Buckets, columns: Column[], agg: Agg): Row[] {
  const out: Row[] = [];
  for (const b of buckets.values()) {
    const values: Record<string, unknown> = {};
    for (const { column, field } of columns) values[column] = reduce(b.values[column], agg, field.type === 'number');
    out.push({ time: b.time, key: b.key, values });
  }
  return out.sort(compareRows);
}

/** キー × 区切りごとに集計する */
export function aggregate(rows: Row[], columns: Column[], interval: number, agg: Agg, tz: string): Row[] {
  return finalize(addRows(new Map(), rows, columns, interval, tz), columns, agg);
}

function reduce(p: Partial, agg: Agg, numeric: boolean): unknown {
  if (agg === 'count') return p.cnt;
  if (p.cnt === 0) return null;
  if (agg === 'last' || !numeric) return p.last;
  switch (agg) {
    case 'sum':
      return round(p.sum);
    case 'avg':
      return round(p.sum / p.cnt);
    case 'min':
      return round(p.min);
    case 'max':
      return round(p.max);
  }
}

/**
 * 行を応答の形にする。
 * long: 1 行 = 時刻 × キー / wide: 1 行 = 時刻、列 = キー_列名（値がない列は null で埋め、全行の列をそろえる）
 */
export function shape(rows: Row[], format: Format): Record<string, unknown>[] {
  if (format === 'long') return rows.map((r) => ({ time: r.time, key: r.key, ...r.values }));
  const byTime = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    let o = byTime.get(r.time);
    if (!o) {
      o = {};
      byTime.set(r.time, o);
    }
    for (const [c, v] of Object.entries(r.values)) o[`${r.key}_${c}`] = v;
  }
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.values).map((c) => `${r.key}_${c}`)))];
  return [...byTime].map(([time, o]) => Object.fromEntries([['time', time], ...names.map((n) => [n, o[n] ?? null])]));
}
