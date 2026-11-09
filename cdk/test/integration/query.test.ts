// キー条件、ページング、上限による打ち切り、属性の変換（DynamoDB Local）
import { describe, expect, it } from 'vitest';
import { H, J0, T0 } from './fixtures';
import { read } from './helpers';

describe('キー条件', () => {
  it('epoch ミリ秒のソートキーで、範囲の両端を含めて読む', async () => {
    const r = await read({ dataset: 'epoch_ms', key: 'room-01', from: `${T0}`, to: `${T0 + 23 * H}` });
    expect(r.rows).toHaveLength(24);
    expect(r.rows[0].time).toBe(T0);
    expect(r.rows[23].time).toBe(T0 + 23 * H);
    expect(Object.keys(r.rows[0].values)).toEqual(['temperature']);
  });

  it('複数のキーを並列に読み、時刻 → キーの順に並べる（重複と空白は除く）', async () => {
    const r = await read({ dataset: 'epoch_ms', key: 'room-01, room-02,room-01', from: `${T0}`, to: `${T0 + 9 * H}` });
    expect(r.rows).toHaveLength(20);
    expect(r.meta.queries).toBe(2);
    expect(r.rows.slice(0, 2).map((x) => x.key)).toEqual(['room-01', 'room-02']);
  });

  it('プレフィックス付きのパーティションキーと複合ソートキー（同じ PK の HUM# は含まない）', async () => {
    const r = await read({ dataset: 'iso_prefix', key: 'a', from: `${T0 + 2 * H}`, to: `${T0 + 5 * H}` });
    expect(r.rows).toHaveLength(4);
    expect(r.rows[0].time).toBe(T0 + 2 * H);
    expect(r.rows.every((x) => x.values.temperature !== null)).toBe(true);
  });

  it('オフセットのない ISO 8601 を、sortKey.timezone（Asia/Tokyo）の時刻として読む', async () => {
    const r = await read({ dataset: 'iso_local', key: 'd1', from: `${T0}`, to: `${T0 + 3 * H}` });
    expect(r.rows.map((x) => x.time)).toEqual([T0, T0 + H, T0 + 2 * H, T0 + 3 * H]);
  });

  it('日付で分けたパーティションキーは、JST の日付境界をまたぐと 2 つの日付を読む', async () => {
    const r = await read({ dataset: 'daily_jst', key: 'm1', from: `${J0 + 23 * H}`, to: `${J0 + 25 * H}` });
    expect(r.rows).toHaveLength(3);
    expect(r.meta.queries).toBe(2);
  });

  it('日付で分けたパーティションキーを 3 日分読む', async () => {
    const r = await read({ dataset: 'daily_jst', key: 'm1', from: `${J0}`, to: `${J0 + 71 * H}` });
    expect(r.rows).toHaveLength(72);
    expect(r.meta.queries).toBe(3);
  });

  it('epoch 秒に切り捨てて広めに読んだ分は、範囲外として除く', async () => {
    const r = await read({ dataset: 'daily_jst', key: 'm1', from: `${J0 + 1}`, to: `${J0 + H - 1}` });
    expect(r.rows).toHaveLength(0);
  });

  it('GSI 経由で読む', async () => {
    const r = await read({ dataset: 'gsi', key: 'r1', from: `${T0}`, to: `${T0 + 20 * H}` });
    expect(r.rows).toHaveLength(6);
  });

  it('設定の時刻形式とテーブルの型が違うと、DynamoDB の ValidationException になる', async () => {
    await expect(read({ dataset: 'wrong_type', key: 'room-01', from: `${T0}`, to: `${T0 + H}` })).rejects.toThrow(
      /Condition parameter type does not match schema type/,
    );
  });
});

describe('ページングと上限', () => {
  const big = { key: 'big', from: `${T0}`, to: `${T0 + 3_000_000}` };

  it('1MB を超える 3000 件を、複数ページで漏れなく読む', async () => {
    const r = await read({ dataset: 'paging', ...big });
    expect(r.rows).toHaveLength(3000);
    expect(r.meta.pages).toBeGreaterThan(1);
    expect(r.meta.truncated).toBe(false);
    expect(r.meta.consumedRcu).toBeGreaterThan(0); // DynamoDB Local でも Query では ConsumedCapacity が返る
  });

  it('maxItems で打ち切る', async () => {
    const r = await read({ dataset: 'paging_cut', ...big });
    expect(r.rows).toHaveLength(1000);
    expect(r.meta).toMatchObject({ truncated: true, truncatedBy: 'maxItems' });
  });

  it('maxPages で打ち切る', async () => {
    const r = await read({ dataset: 'paging_pages', ...big });
    expect(r.meta).toMatchObject({ pages: 2, truncated: true, truncatedBy: 'maxPages' });
    expect(r.rows.length).toBeLessThan(3000);
  });

  it('maxRcu は、超えた時点で次のページを読まずに止める（読んだ分は返す）', async () => {
    const r = await read({ dataset: 'paging_rcu', ...big });
    expect(r.meta).toMatchObject({ pages: 1, truncated: true, truncatedBy: 'maxRcu' });
    expect(r.rows.length).toBeGreaterThan(0);
  });
});

describe('属性の変換', () => {
  const range = { key: 'x', from: `${T0}`, to: `${T0 + H}` };

  it('定義した属性だけを、型・別名・換算をそろえて返す', async () => {
    const r = await read({ dataset: 'transform', ...range });
    const [v0, v1] = r.rows.map((x) => x.values);
    expect(v0).toEqual({
      temp_c: 21.5, // 215 × 0.1、alias
      humidity: 45.5, // 文字列の数値
      meta_fw: '1.2.3', // ネスト属性
      meta_json: '{"fw":"1.2.3","tags":["a"]}', // Map → JSON
      on: true, // 1
      flag: true, // "TRUE"
      tags: '["p","q"]', // Set → JSON
      count: null, // 数値にできない "abc"
      date: '2025-11-03', // 予約語の属性名
    });
    expect(v0).not.toHaveProperty('secret');
    expect(v1).toMatchObject({ temp_c: 0.3, on: false, flag: null, count: 7, humidity: null, meta_fw: null });
  });

  it('fields で列を選ぶ（列名と属性名のどちらでも）', async () => {
    const a = await read({ dataset: 'transform', ...range, fields: 'temp_c, meta.fw' });
    expect(Object.keys(a.rows[0].values)).toEqual(['temp_c', 'meta_fw']);
    const b = await read({ dataset: 'transform', ...range, fields: 'temperature' });
    expect(Object.keys(b.rows[0].values)).toEqual(['temp_c']);
  });
});
