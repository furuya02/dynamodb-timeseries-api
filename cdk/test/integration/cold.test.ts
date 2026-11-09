import { PutObjectCommand } from '@aws-sdk/client-s3';
import { parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';
import type { AthenaRow, AthenaRunner } from '../../lambda/api/cold/athena';
import { createColdReader } from '../../lambda/api/cold/reader';
import { readRows } from '../../lambda/api/reader';
import { parseQueryRequest, type QueryParams } from '../../lambda/api/request';
import { toResponse } from '../../lambda/api/response';
import { ingestDay } from '../../lambda/ingest/day';
import type { ColdRecord } from '../../lambda/ingest/rollup';
import { H, T0 } from './fixtures';
import { client, datasets } from './helpers';

/** S3 に書いた Parquet を記録する偽のクライアント */
function fakeS3() {
  const files: Uint8Array[] = [];
  const s3 = {
    async send(c: unknown): Promise<unknown> {
      if (c instanceof PutObjectCommand) files.push(c.input.Body as Uint8Array);
      return {};
    },
  };
  return { s3: s3 as never, files };
}

async function readParquet(buf: Uint8Array): Promise<ColdRecord[]> {
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const rows = await parquetReadObjects({ file });
  return rows.map((r) => ({ ...r, ts: Number(r.ts), cnt: Number(r.cnt), last_ts: Number(r.last_ts) }) as ColdRecord);
}

/** Athena の代わりに、lambda/api/cold/sql.ts の rangeQuery と同じ集計を TypeScript で行う */
function simulatedAthena(records: ColdRecord[]): AthenaRunner {
  return {
    async run(sql) {
      const m = /\(ts \+ (-?\d+)\) \/ (\d+)/.exec(sql);
      const [off, iv] = [Number(m?.[1]), Number(m?.[2])];
      const groups = new Map<string, ColdRecord[]>();
      for (const r of records) {
        const id = `${r.key}|${r.field}|${Math.floor((r.ts + off) / iv) * iv - off}`;
        groups.set(id, [...(groups.get(id) ?? []), r]);
      }
      const rows: AthenaRow[] = [...groups].map(([id, rs]) => {
        const [key, field, t] = id.split('|');
        const latest = rs.reduce((a, b) => (b.last_ts >= a.last_ts ? b : a));
        const nums = (k: 'val_sum' | 'val_min' | 'val_max') => rs.map((r) => r[k]).filter((v): v is number => v !== null);
        const s = (v: number | null | undefined) => (v === null || v === undefined ? undefined : String(v));
        return {
          key,
          field,
          t,
          cnt: String(rs.reduce((a, r) => a + r.cnt, 0)),
          val_sum: s(nums('val_sum').length ? nums('val_sum').reduce((a, b) => a + b, 0) : null),
          val_min: s(nums('val_min').length ? Math.min(...nums('val_min')) : null),
          val_max: s(nums('val_max').length ? Math.max(...nums('val_max')) : null),
          val_last: s(latest.val_last),
          text_last: latest.text_last ?? undefined,
          last_ts: String(latest.last_ts),
        };
      });
      return { rows, bytesScanned: 0, engineMs: 0 };
    },
  };
}

describe('コールドストアへの取り込み（DynamoDB Local）', () => {
  it('1 日分を 1 分の集計にして Parquet に書く', async () => {
    const { s3, files } = fakeS3();
    const r = await ingestDay(client, { s3, bucket: 'b' }, 'agg', datasets.agg, '2025-11-03');
    expect(r).toMatchObject({ keys: 2, items: 144 + 48 });
    const records = await readParquet(files[0]);
    // a: value 143 件（1 件欠損）+ label 144 件、b: value 48 件 + label 48 件
    expect(records).toHaveLength(143 + 144 + 48 + 48);
    expect(records.find((x) => x.key === 'a' && x.field === 'value' && x.ts === T0)).toMatchObject({ cnt: 1, val_sum: 0, val_last: 0 });
  });

  it('日付で分けたキーでも、UTC の 1 日をまたぐパーティションをすべて読む', async () => {
    const { s3 } = fakeS3();
    // daily_jst は JST の日付で分けたキー。UTC の 2025-11-03 は JST の 11-03 と 11-04 にまたがる
    const r = await ingestDay(client, { s3, bucket: 'b' }, 'daily_jst', datasets.daily_jst, '2025-11-03', ['m1']);
    expect(r.items).toBe(24);
  });

  it.each(['avg', 'min', 'max', 'sum', 'count', 'last'])('コールドから読んだ集計は、DynamoDB から読んだ集計と同じ（agg=%s）', async (agg) => {
    const { s3, files } = fakeS3();
    await ingestDay(client, { s3, bucket: 'b' }, 'agg', datasets.agg, '2025-11-03');
    const cold = createColdReader(simulatedAthena(await readParquet(files[0])), { database: 'db', table: 't' });
    const p: QueryParams = { dataset: 'agg', key: 'a,b', from: `${T0}`, to: `${T0 + 24 * H - 1}`, interval: '1h', agg, tz: 'Asia/Tokyo' };
    const req = parseQueryRequest(datasets, p);
    const fromHot = toResponse(req, await readRows(client, req));
    const fromCold = toResponse(req, undefined, await cold.read(req, req.from, req.to));
    expect(fromCold.rows).toEqual(fromHot.rows);
  });
});
