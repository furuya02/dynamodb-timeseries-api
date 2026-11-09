import { describe, expect, it } from 'vitest';
import { configSchema, resolve } from '../../cdk/lib/config.ts';
import { dateRange, expiresAt, groupByUtcDay, itemsToRows, lastDays } from '../lib/cold.ts';

const raw = {
  table: 'tbl',
  partitionKey: { name: 'deviceId' },
  sortKey: { name: 'ts', format: 'epoch_ms' },
  keys: { values: ['room-01'] },
  fields: [{ name: 'temperature' }],
};
const ds = (extra: Record<string, unknown> = {}) => resolve(configSchema.parse({ datasets: { ds: { ...raw, ...extra } } })).ds;
const T0 = Date.parse('2025-11-03T00:00:00Z');

describe('dateRange / lastDays', () => {
  it('両端を含む UTC の日付', () => {
    expect(dateRange('2025-10-31', '2025-11-02')).toEqual(['2025-10-31', '2025-11-01', '2025-11-02']);
    expect(() => dateRange('2025-11-02', '2025-11-01')).toThrow('日付の範囲');
  });

  it('前日から遡って n 日分', () => {
    expect(lastDays(Date.parse('2025-11-04T05:00:00Z'), 2)).toEqual(['2025-11-02', '2025-11-03']);
  });
});

describe('itemsToRows / groupByUtcDay', () => {
  it('アイテムを行にして、UTC の日付ごとに分ける', () => {
    const rows = itemsToRows(
      [
        { deviceId: 'room-01', ts: T0 - 1, temperature: 20 },
        { deviceId: 'room-01', ts: T0, temperature: '21' },
      ],
      ds(),
    );
    expect(rows).toEqual([
      { time: T0 - 1, key: 'room-01', values: { temperature: 20 } },
      { time: T0, key: 'room-01', values: { temperature: 21 } },
    ]);
    expect([...groupByUtcDay(rows).keys()]).toEqual(['2025-11-02', '2025-11-03']);
  });
});

describe('expiresAt', () => {
  it('cold があれば hotRetention + 1 日後（UNIX 秒）、なければ付けない', () => {
    expect(expiresAt(T0, ds({ cold: { hotRetention: '7d' } }))).toBe(T0 / 1000 + 8 * 86_400);
    expect(expiresAt(T0, ds())).toBeUndefined();
  });
});
