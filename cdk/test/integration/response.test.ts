// 集計、最新値、出力形式、タイムゾーン（DynamoDB Local）
import { describe, expect, it } from 'vitest';
import { H, J0, T0 } from './fixtures';
import { respond } from './helpers';

const day = { from: `${T0}`, to: `${T0 + 24 * H - 1}` };

describe('集計（interval / agg）', () => {
  it('1 時間ごとの平均。欠損は除く（先頭の区切りは (0+1+2+4+5)/5 = 2.4）', async () => {
    const o = await respond({ dataset: 'agg', key: 'a', ...day, interval: '1h', agg: 'avg' });
    expect(o.rows).toHaveLength(24);
    expect(o.rows[0]).toMatchObject({ time: T0, value: 2.4 });
    expect(o.rows[1].value).toBe(8.5);
    expect(o.rows[0].label).toBe('a5'); // 文字列の列は最後の値
  });

  it.each([
    ['min', 0],
    ['max', 5],
    ['sum', 12],
    ['count', 5],
    ['last', 5],
  ])('agg=%s（interval はミリ秒でも指定できる）', async (agg, expected) => {
    const o = await respond({ dataset: 'agg', key: 'a', ...day, interval: '3600000', agg });
    expect(o.rows[0].value).toBe(expected);
  });

  it('count は列の型に関係なく件数で、columns の型は number・単位なし', async () => {
    const o = await respond({ dataset: 'agg', key: 'a,b', ...day, interval: '1h', agg: 'count' });
    expect(o.rows[0].label).toBe(6);
    expect(o.columns.every((c) => c.type === 'number' && c.unit === undefined)).toBe(true);
  });

  it('interval を省略すると生データ', async () => {
    const o = await respond({ dataset: 'agg', key: 'a', ...day });
    expect(o.rows).toHaveLength(144);
    expect(o.meta).toMatchObject({ points: 144, interval: undefined });
  });

  it('複数キーの集計（agg の既定は avg）は、時刻 → キーの順', async () => {
    const o = await respond({ dataset: 'agg', key: 'a,b', ...day, interval: '1h' });
    expect(o.rows).toHaveLength(48);
    expect(o.rows.slice(0, 2).map((x) => x.key)).toEqual(['a', 'b']);
    expect(o.rows[1].value).toBe(100.5);
    expect(o.meta.agg).toBe('avg');
  });

  it('集計時は from を区切りの先頭に丸める（0:30 → 0:00、先頭の区切りも欠けない）', async () => {
    const o = await respond({ dataset: 'agg', key: 'a', from: `${T0 + 30 * 60_000}`, to: `${T0 + 2 * H}`, interval: '1h', agg: 'count' });
    expect(o.rows).toHaveLength(3);
    expect(o.rows[0]).toMatchObject({ time: T0, label: 6 });
  });
});

describe('出力形式（format）', () => {
  it('wide は 1 行 = 時刻、列 = キー_列名', async () => {
    const o = await respond({ dataset: 'agg', key: 'a,b', ...day, interval: '1h', format: 'wide' });
    expect(o.rows).toHaveLength(24);
    expect(Object.keys(o.rows[0])).toEqual(['time', 'a_value', 'a_label', 'b_value', 'b_label']);
    expect(o.rows[0].b_value).toBe(100.5);
  });

  it('wide で値がない時刻の列は null で埋める', async () => {
    const o = await respond({ dataset: 'agg', key: 'a,b', ...day, format: 'wide' });
    expect(o.rows).toHaveLength(144);
    expect(o.rows[1].b_value).toBeNull();
    expect(o.rows[3]).toMatchObject({ b_value: 101, a_value: null });
  });
});

describe('最新値（latest=1）', () => {
  it('キーごとに最新の 1 件を、1 ページだけ読んで返す', async () => {
    const o = await respond({ dataset: 'agg', key: 'a,b', ...day, latest: '1' });
    expect(o.rows.map((x) => [x.key, x.value])).toEqual(
      expect.arrayContaining([
        ['a', 143],
        ['b', 147],
      ]),
    );
    expect(o.meta.pages).toBe(2);
  });

  it('to より後の値は返さない', async () => {
    const o = await respond({ dataset: 'agg', key: 'a', from: `${T0}`, to: `${T0 + 5 * H}`, latest: '1' });
    expect(o.rows).toEqual([{ time: T0 + 5 * H, key: 'a', value: 30, label: 'a30' }]);
  });

  it('ISO 8601 + プレフィックスで範囲の上限を広めに取っても、to を超えない', async () => {
    const o = await respond({ dataset: 'iso_prefix', key: 'a', from: `${T0}`, to: `${T0 + 5 * H}`, latest: 'true' });
    expect(o.rows.map((x) => x.time)).toEqual([T0 + 5 * H]);
  });

  it('日付で分けたキーは新しい日付から読み、データのない日付を飛ばす', async () => {
    const o = await respond({ dataset: 'daily_jst', key: 'm1', from: `${J0}`, to: `${J0 + 96 * H - 1}`, latest: '1' });
    expect(o.rows.map((x) => x.time)).toEqual([J0 + 71 * H]);
    expect(o.meta.queries).toBe(2);
  });
});

describe('集計の区切りのタイムゾーン（tz）', () => {
  const threeDays = { dataset: 'daily_jst', key: 'm1', from: `${J0}`, to: `${J0 + 72 * H - 1}`, interval: '1d', agg: 'count' };

  it('既定はデータセットのタイムゾーン（JST の 0 時で区切って 24 件 × 3）', async () => {
    const o = await respond(threeDays);
    expect(o.rows.map((x) => [(x.time as number) - J0, x.watt])).toEqual([
      [0, 24],
      [24 * H, 24],
      [48 * H, 24],
    ]);
  });

  it('tz=UTC なら UTC の 0 時で区切る（9 / 24 / 24 / 15）', async () => {
    const o = await respond({ ...threeDays, tz: 'UTC' });
    expect(o.rows.map((x) => x.watt)).toEqual([9, 24, 24, 15]);
  });
});
