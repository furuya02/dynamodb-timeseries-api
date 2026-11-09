// ---------------------------------------------------------------
// 1 分の集計（コールドストアの 1 行 = キー × 列 × 1 分）と Parquet への書き出し
// 定期実行（scheduled.ts）、過去分の取り込み（scripts/cold-backfill.ts）、サンプルデータ（scripts/seed.ts）で使う
// ---------------------------------------------------------------
import { parquetWriteBuffer } from 'hyparquet-writer';
import { addRows } from '../api/aggregate';
import { COLD_STEP_MS } from '../api/cold/sql';
import type { Column, Row } from '../api/types';

/** コールドストアの 1 行（列名は lambda/api/cold/sql.ts の COLD_COLUMNS と同じ） */
export interface ColdRecord {
  key: string;
  field: string;
  ts: number;
  cnt: number;
  val_sum: number | null;
  val_min: number | null;
  val_max: number | null;
  val_last: number | null;
  text_last: string | null;
  last_ts: number;
}

/** 行（型をそろえた値）を 1 分ごとに集計する。値がない（すべて欠損の）列は書かない */
export function rollup(rows: Row[], columns: Column[]): ColdRecord[] {
  const out: ColdRecord[] = [];
  for (const b of addRows(new Map(), rows, columns, COLD_STEP_MS, 'UTC').values()) {
    for (const { column, field } of columns) {
      const p = b.values[column];
      if (p.cnt === 0) continue;
      const numeric = field.type === 'number';
      out.push({
        key: b.key,
        field: field.name,
        ts: b.time,
        cnt: p.cnt,
        val_sum: numeric ? p.sum : null,
        val_min: numeric ? p.min : null,
        val_max: numeric ? p.max : null,
        val_last: numeric ? (p.last as number) : null,
        text_last: numeric ? null : String(p.last),
        last_ts: p.lastTs,
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key) || a.field.localeCompare(b.field));
}

/** Parquet（Snappy 圧縮）にする。型は Glue テーブルの定義と合わせる */
export function toParquet(records: ColdRecord[]): Uint8Array {
  // INT64 の列は bigint で渡す（number のままだとエラーになる）
  const col = <K extends keyof ColdRecord>(name: K, type: 'STRING' | 'INT64' | 'DOUBLE') => ({
    name,
    type,
    data: records.map((r) => (type === 'INT64' ? BigInt(r[name] as number) : r[name])),
  });
  const buffer = parquetWriteBuffer({
    columnData: [
      col('key', 'STRING'),
      col('field', 'STRING'),
      col('ts', 'INT64'),
      col('cnt', 'INT64'),
      col('val_sum', 'DOUBLE'),
      col('val_min', 'DOUBLE'),
      col('val_max', 'DOUBLE'),
      col('val_last', 'DOUBLE'),
      col('text_last', 'STRING'),
      col('last_ts', 'INT64'),
    ],
  });
  return new Uint8Array(buffer);
}
