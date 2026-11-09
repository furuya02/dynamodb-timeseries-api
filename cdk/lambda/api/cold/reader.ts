// ---------------------------------------------------------------
// コールドストアの読み込み（SQL を実行し、結果を途中集計 / 行にする）
// ---------------------------------------------------------------
import type { Bucket, Partial } from '../aggregate';
import { offsetMs } from '../time';
import { convert } from '../transform';
import type { Column, QueryRequest, Row } from '../types';
import type { AthenaRow, AthenaRunner } from './athena';
import { COLD_STEP_MS, type ColdTable, latestQuery, rangeQuery } from './sql';

export interface ColdMeta {
  /** コールドストアから読んだ範囲（UNIX ミリ秒、両端を含む） */
  from: number;
  to: number;
  /** Athena が返した行数（キー × 列 × 区切り） */
  rows: number;
  bytesScanned: number;
  engineMs: number;
  truncated: boolean;
}

export interface ColdResult {
  /** 区切りごとの途中集計（範囲の問い合わせ） */
  buckets: Bucket[];
  /** キーごとの最新値（latest） */
  rows: Row[];
  meta: ColdMeta;
}

export interface ColdReader {
  read(req: QueryRequest, from: number, to: number): Promise<ColdResult>;
}

export function createColdReader(runner: AthenaRunner, table: ColdTable): ColdReader {
  return {
    async read(req, from, to) {
      const byField = new Map(req.columns.map((c) => [c.field.name, c]));
      const filter = { dataset: req.name, keys: req.keys, fields: [...byField.keys()], from, to };
      if (req.latest) {
        const q = latestQuery(table, filter);
        const r = await runner.run(q.sql, q.params);
        return { buckets: [], rows: latestRows(r.rows, req.columns, byField), meta: meta(from, to, r, false) };
      }
      // interval がないとき（生データ）は 1 分の集計をそのまま返す
      const interval = req.interval ?? COLD_STEP_MS;
      const limit = req.dataset.limits.maxItems;
      const q = rangeQuery(table, { ...filter, interval, offset: offsetMs(req.tz, from), limit: limit + 1 });
      const r = await runner.run(q.sql, q.params);
      const truncated = r.rows.length > limit;
      const buckets = toBuckets(r.rows.slice(0, limit), byField);
      return { buckets, rows: [], meta: meta(from, to, r, truncated) };
    },
  };
}

const meta = (from: number, to: number, r: { rows: unknown[]; bytesScanned: number; engineMs: number }, truncated: boolean): ColdMeta => ({
  from,
  to,
  rows: r.rows.length,
  bytesScanned: r.bytesScanned,
  engineMs: r.engineMs,
  truncated,
});

const num = (s: string | undefined): number => (s === undefined ? Number.NaN : Number(s));

/** 最後の値を列の型に戻す（取り込み時に型をそろえて保存しているので、数値はそのまま、それ以外は文字列から戻す） */
function lastValue(r: AthenaRow, c: Column): unknown {
  if (c.field.type === 'number') return r.val_last === undefined ? null : num(r.val_last);
  if (r.text_last === undefined) return null;
  return c.field.type === 'json' ? r.text_last : convert(r.text_last, c.field);
}

function toBuckets(rows: AthenaRow[], byField: Map<string, Column>): Bucket[] {
  const out = new Map<string, Bucket>();
  for (const r of rows) {
    const c = byField.get(r.field ?? '');
    const key = r.key ?? '';
    const time = num(r.t);
    if (!c || !Number.isFinite(time)) continue;
    const id = `${key}\u0000${time}`;
    let b = out.get(id);
    if (!b) {
      b = { time, key, values: {} };
      out.set(id, b);
    }
    const numeric = c.field.type === 'number';
    const p: Partial = {
      cnt: num(r.cnt) || 0,
      sum: numeric ? num(r.val_sum) : 0,
      min: numeric ? num(r.val_min) : 0,
      max: numeric ? num(r.val_max) : 0,
      last: lastValue(r, c),
      lastTs: num(r.last_ts),
    };
    b.values[c.column] = p;
  }
  return [...out.values()];
}

/** キーごとに、列ごとの最後の値を 1 行にまとめる。時刻は最も新しい値の時刻 */
function latestRows(rows: AthenaRow[], columns: Column[], byField: Map<string, Column>): Row[] {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const c = byField.get(r.field ?? '');
    const key = r.key ?? '';
    if (!c) continue;
    let row = out.get(key);
    if (!row) {
      row = { time: Number.NEGATIVE_INFINITY, key, values: Object.fromEntries(columns.map((x) => [x.column, null])) };
      out.set(key, row);
    }
    row.values[c.column] = lastValue(r, c);
    row.time = Math.max(row.time, num(r.last_ts));
  }
  return [...out.values()].filter((r) => Number.isFinite(r.time));
}
