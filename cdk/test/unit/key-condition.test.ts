import { describe, expect, it } from 'vitest';
import { partitionValues, readTime, sortRange } from '../../lambda/api/key-condition';
import { base } from './helpers';

const T0 = Date.parse('2025-11-03T00:00:00Z');
const H = 3_600_000;

describe('partitionValues', () => {
  it('template の {key} を置き換える', () => {
    expect(partitionValues(base({ partitionKey: { name: 'pk', template: 'room#{key}' } }), 'a', T0, T0)).toEqual(['room#a']);
  });

  it('日付で分けたキーは、期間内の日付ごとに値を作る（tz の日付で区切る）', () => {
    const d = base({ partitionKey: { name: 'pk', template: '{key}#{yyyy-MM-dd}', bucket: 'daily', timezone: 'Asia/Tokyo' } });
    expect(partitionValues(d, 'm1', T0 + 14 * H, T0 + 16 * H)).toEqual(['m1#2025-11-03', 'm1#2025-11-04']);
  });

  it('月で分けたキー', () => {
    const d = base({ partitionKey: { name: 'pk', template: '{yyyy-MM}|{key}', bucket: 'monthly' } });
    expect(partitionValues(d, 'x', Date.parse('2025-10-31T00:00:00Z'), T0)).toEqual(['2025-10|x', '2025-11|x']);
  });
});

describe('sortRange', () => {
  it('epoch_ms はそのまま', () => {
    expect(sortRange(base(), T0, T0 + H)).toEqual([T0, T0 + H]);
  });

  it('epoch_s は秒に切り捨てる', () => {
    const d = base({ sortKey: { name: 'ts', format: 'epoch_s' } });
    expect(sortRange(d, T0 + 999, T0 + 1999)).toEqual([T0 / 1000, T0 / 1000 + 1]);
  });

  it('プレフィックス付きの epoch は文字列にする', () => {
    const d = base({ sortKey: { name: 'sk', format: 'epoch_s', prefix: 'TEMP#' } });
    expect(sortRange(d, T0, T0)).toEqual([`TEMP#${T0 / 1000}`, `TEMP#${T0 / 1000}`]);
  });

  it('iso8601 は tz の壁時計で、上限に最大の文字を付けて末尾の違い（Z / .000Z / +09:00）を含める', () => {
    const d = base({ sortKey: { name: 'sk', format: 'iso8601', prefix: 'T#', timezone: 'Asia/Tokyo' } });
    const [lo, hi] = sortRange(d, T0, T0 + H) as [string, string];
    expect(lo).toBe('T#2025-11-03T09:00:00');
    expect(hi).toBe('T#2025-11-03T10:00:00￿');
    expect('T#2025-11-03T10:00:00.000+09:00' < hi).toBe(true);
  });
});

describe('readTime', () => {
  it.each([
    [{ name: 'ts', format: 'epoch_ms' }, T0, T0],
    [{ name: 'ts', format: 'epoch_s' }, T0 / 1000, T0],
    [{ name: 'ts', format: 'epoch_s', prefix: 'P#' }, `P#${T0 / 1000}`, T0],
    [{ name: 'ts', format: 'iso8601', prefix: 'P#' }, 'P#2025-11-03T00:00:00Z', T0],
    [{ name: 'ts', format: 'iso8601', timezone: 'Asia/Tokyo' }, '2025-11-03T09:00:00', T0],
  ])('%j の %s', (sortKey, value, expected) => {
    expect(readTime(base({ sortKey }), value)).toBe(expected);
  });

  it('読めない値は NaN', () => {
    expect(readTime(base(), 'abc')).toBeNaN();
  });
});
