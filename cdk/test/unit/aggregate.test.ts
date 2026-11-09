import { describe, expect, it } from 'vitest';
import { aggregate, shape } from '../../lambda/api/aggregate';
import type { Column, Row } from '../../lambda/api/types';

const T0 = Date.parse('2025-11-03T00:00:00Z');
const M = 60_000;
const cols: Column[] = [
  { column: 'v', path: ['v'], field: { name: 'v', type: 'number' } as Column['field'] },
  { column: 's', path: ['s'], field: { name: 's', type: 'string' } as Column['field'] },
];
const row = (min: number, key: string, v: unknown, s: unknown = `s${min}`): Row => ({ time: T0 + min * M, key, values: { v, s } });

describe('aggregate', () => {
  const rows = [row(0, 'a', 1), row(1, 'a', null), row(2, 'a', 3), row(5, 'a', 10), row(0, 'b', 100)];

  it.each([
    ['avg', 2],
    ['min', 1],
    ['max', 3],
    ['sum', 4],
    ['count', 2],
    ['last', 3],
  ] as const)('%s は欠損を除いて集計する', (agg, expected) => {
    const out = aggregate(rows, cols, 5 * M, agg, 'UTC');
    expect(out.find((r) => r.key === 'a' && r.time === T0)?.values.v).toBe(expected);
  });

  it('文字列の列は avg でも最後の値、count は件数', () => {
    expect(aggregate(rows, cols, 5 * M, 'avg', 'UTC')[0].values.s).toBe('s2');
    expect(aggregate(rows, cols, 5 * M, 'count', 'UTC')[0].values.s).toBe(3);
  });

  it('値がすべて欠損なら null（count は 0）', () => {
    const r = [row(0, 'a', null, null)];
    expect(aggregate(r, cols, 5 * M, 'avg', 'UTC')[0].values).toEqual({ v: null, s: null });
    expect(aggregate(r, cols, 5 * M, 'count', 'UTC')[0].values).toEqual({ v: 0, s: 0 });
  });

  it('時刻 → キーの順に並べる', () => {
    expect(aggregate(rows, cols, 5 * M, 'avg', 'UTC').map((r) => [r.time - T0, r.key])).toEqual([
      [0, 'a'],
      [0, 'b'],
      [5 * M, 'a'],
    ]);
  });

  it('浮動小数点の誤差を丸める（0.1 + 0.2）', () => {
    expect(aggregate([row(0, 'a', 0.1), row(1, 'a', 0.2)], cols, 5 * M, 'sum', 'UTC')[0].values.v).toBe(0.3);
  });
});

describe('shape', () => {
  const rows = [row(0, 'a', 1), row(0, 'b', 2), row(1, 'a', 3)];

  it('long は時刻・キー・列', () => {
    expect(shape(rows, 'long')[0]).toEqual({ time: T0, key: 'a', v: 1, s: 's0' });
  });

  it('wide は 1 行 = 時刻、値がない列は null で埋めて全行の列をそろえる', () => {
    expect(shape(rows, 'wide')).toEqual([
      { time: T0, a_v: 1, a_s: 's0', b_v: 2, b_s: 's0' },
      { time: T0 + M, a_v: 3, a_s: 's1', b_v: null, b_s: null },
    ]);
  });

  it('行がなければ空', () => {
    expect(shape([], 'wide')).toEqual([]);
  });
});
