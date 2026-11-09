import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../cdk/lib/config.ts';
import { datasetName, type InferInput, type Item, inferDataset, inferPartitionKey, keyPattern } from '../lib/infer.ts';

const S = (s: string): AttributeValue => ({ S: s });
const N = (n: number): AttributeValue => ({ N: String(n) });
const T0 = Date.parse('2025-11-03T00:00:00Z');
const input = (over: Partial<InferInput>): InferInput => ({ table: 'tbl', partitionKey: 'pk', sortKey: 'sk', tableKeys: ['pk', 'sk'], items: [], ...over });

/** 推定した定義が、cdk の設定スキーマの検証を通るか */
const validate = (r: ReturnType<typeof inferDataset>) => configSchema.safeParse({ datasets: { [r.name]: r.dataset } });

describe('inferDataset', () => {
  it('サンプルテーブル（epoch ミリ秒、room-01 だけ見つかる）→ キーの形から pattern を作る', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ pk: S('room-01'), sk: N(T0 + i * 60_000), temperature: N(20.1), humidity: N(55) }));
    const r = inferDataset(input({ table: 'dynamodb-timeseries-api-sample', items }));
    expect(r.name).toBe('dynamodb_timeseries_api_sample');
    expect(r.dataset).toEqual({
      description: 'dynamodb-timeseries-api-sample',
      table: 'dynamodb-timeseries-api-sample',
      partitionKey: { name: 'pk' },
      sortKey: { name: 'sk', format: 'epoch_ms' },
      keys: { pattern: '^room-[0-9]{2}$' },
      fields: [
        { name: 'temperature', type: 'number' },
        { name: 'humidity', type: 'number' },
      ],
    });
    expect(r.notes).toContain('見つかったキー: room-01。keys.pattern はその形から作った案です（すべてのキーを読んだわけではありません）');
    expect(validate(r).success).toBe(true);
  });

  it('シングルテーブル設計（TEMP# と HUM#、登録用アイテムが混在）→ 多数派の種類で推定し、ほかの種類を注記する', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({ pk: S(i < 3 ? 'room#a' : 'room#b'), sk: S(`HUM#2025-11-03T0${i}:00:00.000Z`), humidity: N(i) })),
      ...Array.from({ length: 4 }, (_, i) => ({ pk: S('room#b'), sk: S(`TEMP#2025-11-03T0${i}:00:00.000Z`), temperature: N(i) })),
      { pk: S('devices'), sk: S('a'), id: S('a') },
    ];
    const r = inferDataset(input({ items }));
    expect(r.dataset).toMatchObject({
      partitionKey: { name: 'pk', template: 'room#{key}' },
      sortKey: { name: 'sk', format: 'iso8601', prefix: 'HUM#' },
      keys: { pattern: '^[a-z]+$' },
      fields: [{ name: 'humidity', type: 'number' }],
    });
    expect(r.notes.join('\n')).toContain('ソートキーに複数の種類があります（HUM# 6 件、TEMP# 4 件）');
    expect(r.notes.join('\n')).toContain('ソートキーの形式が違うアイテムが 5 件ありました');
    expect(validate(r).success).toBe(true);
  });

  it('日付で分けたパーティションキー + epoch 秒 → bucket: daily と timezone の注記', () => {
    const items = [0, 1, 2].map((d) => ({ pk: S(`m1#2025-11-0${3 + d}`), sk: N(T0 / 1000 + d * 86400), watt: N(d) }));
    const r = inferDataset(input({ items }));
    expect(r.dataset).toMatchObject({
      partitionKey: { name: 'pk', template: '{key}#{yyyy-MM-dd}', bucket: 'daily' },
      sortKey: { format: 'epoch_s' },
      keys: { pattern: '^m[0-9]$' },
    });
    expect(r.notes.join('\n')).toContain('bucket: daily');
    expect(validate(r).success).toBe(true);
  });

  it('タイムゾーンのない ISO 8601 → sortKey.timezone の注記', () => {
    const r = inferDataset(input({ items: [{ pk: S('d1'), sk: S('2025-11-03T09:00:00'), v: N(1) }] }));
    expect(r.dataset).toMatchObject({ sortKey: { format: 'iso8601' } });
    expect(r.notes.join('\n')).toContain('タイムゾーンの表記がありません');
  });

  it('プレフィックス + epoch（TEMP#1730000000）', () => {
    const r = inferDataset(
      input({
        items: [
          { pk: S('d'), sk: S('TEMP#1762128000') },
          { pk: S('d'), sk: S('TEMP#1762128060') },
        ],
      }),
    );
    expect(r.dataset).toMatchObject({ sortKey: { format: 'epoch_s', prefix: 'TEMP#' } });
  });

  it('GSI では、テーブル本体のキーを属性から除き、index を書く', () => {
    const items = [0, 1].map((i) => ({ id: S(`x${i}`), ts: N(T0 + i), room: S('r1'), v: N(i) }));
    const r = inferDataset(input({ table: 't-gsi', index: 'byRoom', partitionKey: 'room', sortKey: 'ts', tableKeys: ['id', 'ts'], items }));
    expect(r.dataset).toMatchObject({ index: 'byRoom', description: 't-gsi (byRoom)', fields: [{ name: 'v', type: 'number' }] });
  });

  it('属性の型: 数値の文字列は number、Map は json（中の値を列にする注記）、混在は string（注記）', () => {
    const items: Item[] = [
      { pk: S('a'), sk: N(T0), num: S('45.5'), meta: { M: { fw: S('1') } }, mixed: N(1), flag: { BOOL: true } },
      { pk: S('a'), sk: N(T0 + 1), num: S('46'), mixed: S('x'), nothing: { NULL: true } },
    ];
    const r = inferDataset(input({ items }));
    expect(r.dataset.fields).toEqual([
      { name: 'num', type: 'number' },
      { name: 'meta', type: 'json' },
      { name: 'mixed', type: 'string' },
      { name: 'flag', type: 'boolean' },
      { name: 'nothing', type: 'string' },
    ]);
    expect(r.notes.join('\n')).toContain('meta.fw のように書けます');
    expect(r.notes.join('\n')).toContain('mixed は型が混在しています（number / string）');
  });

  it('時刻形式を推定できなければ注記し、属性がなければ仮の列を置く', () => {
    const r = inferDataset(input({ items: [{ pk: S('a'), sk: S('hello') }] }));
    expect(r.notes.join('\n')).toContain('ソートキーの時刻形式を推定できませんでした（例: hello）');
    expect(r.dataset.fields).toEqual([{ name: 'value', type: 'number' }]);
  });

  it('--name を指定すればその名前', () => {
    expect(inferDataset(input({ name: 'mine', items: [{ pk: S('a'), sk: N(T0) }] })).name).toBe('mine');
  });
});

describe('inferPartitionKey', () => {
  it('文字単位ではなく区切り文字の単位で {key} を決める（room-01 と room-02 から room-0{key} にしない）', () => {
    expect(inferPartitionKey('pk', ['room-01', 'room-02'], []).partitionKey).toEqual({ name: 'pk' });
    expect(inferPartitionKey('pk', ['site#tokyo#dev-1', 'site#tokyo#dev-2'], []).partitionKey).toEqual({ name: 'pk', template: 'site#tokyo#{key}' });
  });

  it('形がそろわなければ template を推定せずに注記する', () => {
    const notes: string[] = [];
    expect(inferPartitionKey('pk', ['a#b', 'c'], notes)).toEqual({ partitionKey: { name: 'pk' }, keys: ['a#b', 'c'] });
    expect(notes[0]).toContain('template を推定できませんでした');
  });

  it('月で分けたキー', () => {
    expect(inferPartitionKey('pk', ['2025-10|x', '2025-11|y'], []).partitionKey).toEqual({ name: 'pk', template: '{yyyy-MM}|{key}', bucket: 'monthly' });
  });
});

describe('keyPattern / datasetName', () => {
  it.each([
    [['room-01', 'room-02'], '^room-[0-9]{2}$'],
    [['m1'], '^m[0-9]$'],
    [['a', 'b'], '^[a-z]+$'],
    [['dev.1'], '^dev\\.[0-9]$'],
    [['big', 'room-01'], '^[A-Za-z0-9_.:-]{1,64}$'],
    [[], '^[A-Za-z0-9_.:-]{1,64}$'],
  ])('%j → %s', (keys, expected) => {
    expect(keyPattern(keys)).toBe(expected);
    if (keys.length > 0) for (const k of keys) expect(new RegExp(expected).test(k)).toBe(true);
  });

  it('テーブル名から、データセット名の規則に合う名前を作る', () => {
    expect(datasetName('IoT-Metrics.v2')).toBe('iot_metrics_v2');
    expect(datasetName('123-abc')).toBe('abc');
    expect(datasetName('---')).toBe('my_dataset');
  });
});
