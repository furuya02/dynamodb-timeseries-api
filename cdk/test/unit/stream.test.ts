import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { datasetsByTable, matchItem, templateRegex, toFirehoseRecords } from '../../lambda/ingest/stream-match';
import { base } from './helpers';

const T0 = Date.parse('2025-11-03T00:00:00Z');
const M = 60_000;

describe('templateRegex', () => {
  it.each([
    ['{key}', 'room-01', 'room-01'],
    ['room#{key}', 'room#a', 'a'],
    ['{key}#{yyyy-MM-dd}', 'm1#2025-11-03', 'm1'],
    ['{key}#{yyyy-MM}', 'm1#2025-11', 'm1'],
    ['a.b({key})', 'a.b(x)', 'x'],
  ])('%s と %s → %s', (template, value, key) => {
    expect(templateRegex(template).exec(value)?.groups?.key).toBe(key);
  });

  it('形の合わない値は一致しない', () => {
    expect(templateRegex('room#{key}').test('devices')).toBe(false);
    expect(templateRegex('{key}#{yyyy-MM-dd}').test('m1#2025-11')).toBe(false);
  });
});

describe('matchItem', () => {
  const d = base({ partitionKey: { name: 'pk', template: 'room#{key}' }, sortKey: { name: 'sk', format: 'iso8601', prefix: 'TEMP#' }, cold: {} });

  it('キー・時刻・値を取り出す', () => {
    expect(matchItem(d, { pk: 'room#a', sk: 'TEMP#2025-11-03T00:00:00Z', value: '1.5' })).toEqual({ time: T0, key: 'a', values: { value: 1.5 } });
  });

  it.each<[Record<string, unknown>, string]>([
    [{ pk: 'devices', sk: 'TEMP#2025-11-03T00:00:00Z' }, 'テンプレートに合わない'],
    [{ pk: 'room#z', sk: 'TEMP#2025-11-03T00:00:00Z' }, '許可されていないキー'],
    [{ pk: 'room#a', sk: 'HUM#2025-11-03T00:00:00Z' }, 'プレフィックスが違う'],
    [{ pk: 'room#a', sk: 'TEMP#xxx' }, '時刻として読めない'],
    [{ pk: 'room#a' }, 'ソートキーがない'],
  ])('%j（%s）は対象外', (item) => {
    expect(matchItem(d, item)).toBeUndefined();
  });
});

describe('toFirehoseRecords', () => {
  const ds = { ds: base({ cold: {} }), other: base({ table: 'other' }) };
  const record = (eventName: string, item: Record<string, unknown>, table = 'tbl') => ({
    eventName,
    eventSourceARN: `arn:aws:dynamodb:ap-northeast-1:123456789012:table/${table}/stream/2025-11-01T00:00:00.000`,
    dynamodb: { NewImage: marshall(item) },
  });

  it('INSERT を 1 分に集計し、dataset と dt（UTC）を付ける。cold のないデータセットと他のテーブルは除く', () => {
    const event = {
      Records: [
        record('INSERT', { pk: 'a', ts: T0 + 1000, value: 1 }),
        record('INSERT', { pk: 'a', ts: T0 + 2000, value: 3 }),
        record('MODIFY', { pk: 'a', ts: T0 + 3000, value: 100 }),
        record('INSERT', { pk: 'a', ts: T0 + M, value: 5 }, 'other'),
      ],
    } as unknown as DynamoDBStreamEvent;
    expect(toFirehoseRecords(ds, datasetsByTable(ds), event)).toEqual([
      {
        key: 'a',
        field: 'value',
        ts: T0,
        cnt: 2,
        val_sum: 4,
        val_min: 1,
        val_max: 3,
        val_last: 3,
        text_last: null,
        last_ts: T0 + 2000,
        dataset: 'ds',
        dt: '2025-11-03',
      },
    ]);
  });
});
