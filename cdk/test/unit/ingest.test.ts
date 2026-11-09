import { type DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { parquetMetadata, parquetReadObjects, parquetSchema } from 'hyparquet';
import { describe, expect, it } from 'vitest';
import { COLD_COLUMNS } from '../../lambda/api/cold/sql';
import { selectColumns } from '../../lambda/api/transform';
import { dayRange, ingestDay, partitionPrefix, writeDay } from '../../lambda/ingest/day';
import { rollup, toParquet } from '../../lambda/ingest/rollup';
import { yesterday } from '../../lambda/ingest/scheduled-date';
import { base, fakeClient } from './helpers';

const M = 60_000;
const DAY = '2025-11-03';
const T0 = Date.parse(`${DAY}T00:00:00Z`);
const d = base({ fields: [{ name: 'value' }, { name: 'state', type: 'string' }, { name: 'on', type: 'boolean' }], cold: {} });
const columns = selectColumns(d, undefined);

/** S3 に送ったコマンドを記録する偽のクライアント */
function fakeS3(existing: string[] = []) {
  const sent: unknown[] = [];
  const s3 = {
    async send(c: unknown): Promise<unknown> {
      sent.push(c);
      if (c instanceof ListObjectsV2Command) return { Contents: existing.map((Key) => ({ Key })) };
      return {};
    },
  };
  return { s3: s3 as never, sent };
}

describe('rollup', () => {
  it('キー × 列 × 1 分の件数・合計・最小・最大・最後の値。欠損は数えず、値のない列は書かない', () => {
    const rows = [
      { time: T0 + 1000, key: 'a', values: { value: 1, state: 'x', on: true } },
      { time: T0 + 2000, key: 'a', values: { value: 3, state: null, on: false } },
      { time: T0 + M, key: 'a', values: { value: null, state: 'y', on: null } },
    ];
    expect(rollup(rows, columns)).toEqual([
      { key: 'a', field: 'on', ts: T0, cnt: 2, val_sum: null, val_min: null, val_max: null, val_last: null, text_last: 'false', last_ts: T0 + 2000 },
      { key: 'a', field: 'state', ts: T0, cnt: 1, val_sum: null, val_min: null, val_max: null, val_last: null, text_last: 'x', last_ts: T0 + 1000 },
      { key: 'a', field: 'value', ts: T0, cnt: 2, val_sum: 4, val_min: 1, val_max: 3, val_last: 3, text_last: null, last_ts: T0 + 2000 },
      { key: 'a', field: 'state', ts: T0 + M, cnt: 1, val_sum: null, val_min: null, val_max: null, val_last: null, text_last: 'y', last_ts: T0 + M },
    ]);
  });
});

describe('toParquet', () => {
  it('Glue テーブルと同じ列名・型で書き、読み戻せる', async () => {
    const records = rollup([{ time: T0, key: 'a', values: { value: 1.5, state: 'x', on: null } }], columns);
    const buf = toParquet(records);
    const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const schema = parquetSchema(parquetMetadata(file));
    expect(schema.children.map((c) => [c.element.name, c.element.type])).toEqual(
      COLD_COLUMNS.map(([name, type]) => [name, { string: 'BYTE_ARRAY', bigint: 'INT64', double: 'DOUBLE' }[type]]),
    );
    const rows = await parquetReadObjects({ file });
    expect(rows.map((r) => ({ ...r, ts: Number(r.ts), cnt: Number(r.cnt), last_ts: Number(r.last_ts) }))).toEqual(records);
  });
});

describe('dayRange / yesterday', () => {
  it('UTC の 1 日', () => {
    expect(dayRange(DAY)).toEqual({ from: T0, to: T0 + 86_400_000 - 1 });
    expect(() => dayRange('2025/11/03')).toThrow('yyyy-MM-dd');
    expect(yesterday(Date.parse('2025-11-04T01:00:00Z'))).toBe(DAY);
  });
});

describe('writeDay', () => {
  const records = rollup([{ time: T0, key: 'a', values: { value: 1, state: null, on: null } }], columns);

  it('新しいファイルを書いてから、同じ日付のフォルダの他のファイルを消す（やり直しても重複しない）', async () => {
    const prefix = partitionPrefix('ds', DAY);
    const { s3, sent } = fakeS3([`${prefix}part-0.parquet`, `${prefix}firehose-1.parquet`]);
    const bytes = await writeDay({ s3, bucket: 'b' }, 'ds', DAY, records);
    expect(bytes).toBeGreaterThan(0);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({ Bucket: 'b', Key: 'data/dataset=ds/dt=2025-11-03/part-0.parquet' });
    expect((sent[2] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([{ Key: `${prefix}firehose-1.parquet` }]);
  });

  it('集計が 0 件ならフォルダを空にする', async () => {
    const prefix = partitionPrefix('ds', DAY);
    const { s3, sent } = fakeS3([`${prefix}part-0.parquet`]);
    expect(await writeDay({ s3, bucket: 'b' }, 'ds', DAY, [])).toBe(0);
    expect(sent.some((c) => c instanceof PutObjectCommand)).toBe(false);
    expect((sent.at(-1) as DeleteObjectsCommand).input.Delete?.Objects).toEqual([{ Key: `${prefix}part-0.parquet` }]);
  });
});

describe('ingestDay', () => {
  it('キーごとに 1 日分を Query で読み（上限で打ち切らない）、集計して書く', async () => {
    const { client, calls } = fakeClient((input) => ({
      Items:
        input.ExpressionAttributeValues?.[':pk'] === 'a'
          ? [
              { ts: T0, value: 1 },
              { ts: T0 + 86_400_000, value: 9 },
            ]
          : [],
      ConsumedCapacity: { CapacityUnits: 0.5 },
    }));
    const { s3 } = fakeS3();
    const r = await ingestDay(client, { s3, bucket: 'b' }, 'ds', d, DAY);
    expect(r).toMatchObject({ dataset: 'ds', date: DAY, keys: 2, items: 2, records: 1, consumedRcu: 1 });
    expect(calls.map((c) => [c.ExpressionAttributeValues?.[':pk'], c.ExpressionAttributeValues?.[':lo'], c.ExpressionAttributeValues?.[':hi']])).toEqual([
      ['a', T0, T0 + 86_400_000 - 1],
      ['b', T0, T0 + 86_400_000 - 1],
    ]);
  });

  it('キーを列挙できなければエラー（Scan はしない）', async () => {
    const { client } = fakeClient(() => ({}));
    const { s3 } = fakeS3();
    await expect(ingestDay(client, { s3, bucket: 'b' }, 'ds', base({ keys: { pattern: '.*' } }), DAY)).rejects.toThrow('keys.values か keys.list');
  });
});
