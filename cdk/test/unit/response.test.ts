import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lambda/api/errors';
import { measureResponse, toResponse } from '../../lambda/api/response';
import { selectColumns } from '../../lambda/api/transform';
import type { QueryRequest, ReadResult } from '../../lambda/api/types';
import { base } from './helpers';

const T0 = Date.parse('2025-11-03T00:00:00Z');
const d = base({ fields: [{ name: 'value', unit: 'celsius' }] });
const req = (over: Partial<QueryRequest> = {}): QueryRequest => ({
  name: 'ds',
  dataset: d,
  keys: ['a'],
  from: T0,
  to: T0 + 600_000,
  columns: selectColumns(d, undefined),
  agg: 'avg',
  latest: false,
  format: 'long',
  tz: 'UTC',
  ...over,
});
const result: ReadResult = {
  rows: [0, 1, 2].map((i) => ({ time: T0 + i * 60_000, key: 'a', values: { value: i } })),
  meta: { queries: 1, pages: 1, items: 3, truncated: false, consumedRcu: 0.5 },
};

describe('toResponse', () => {
  it('生データは rows、columns（型と単位）、meta（読み込みの情報と点数）', () => {
    const r = toResponse(req(), result);
    expect(r.rows).toHaveLength(3);
    expect(r.columns).toEqual([{ name: 'value', type: 'number', unit: 'celsius' }]);
    expect(r.meta).toEqual({
      dataset: 'ds',
      queries: 1,
      pages: 1,
      items: 3,
      truncated: false,
      consumedRcu: 0.5,
      points: 3,
      interval: undefined,
      agg: undefined,
    });
  });

  it('interval があれば集計する', () => {
    const r = toResponse(req({ interval: 600_000 }), result);
    expect(r.rows).toEqual([{ time: T0, key: 'a', value: 1 }]);
    expect(r.meta).toMatchObject({ points: 1, interval: 600_000, agg: 'avg' });
  });

  it('count のとき columns は number で単位なし', () => {
    expect(toResponse(req({ interval: 600_000, agg: 'count' }), result).columns).toEqual([{ name: 'value', type: 'number', unit: undefined }]);
  });
});

describe('measureResponse', () => {
  it('バイト数を返す（日本語は UTF-8 のバイト数）', () => {
    const body = toResponse(req(), { ...result, rows: [{ time: T0, key: 'あ', values: { value: 1 } }] });
    expect(measureResponse(body)).toBe(Buffer.byteLength(JSON.stringify(body)));
  });

  it('上限を超えると理由つきの 400', () => {
    const body = toResponse(req(), result);
    expect(() => measureResponse(body, 10)).toThrow(ApiError);
    expect(() => measureResponse(body, 10)).toThrow(/応答が大きすぎます.*interval で集計する/);
  });
});
