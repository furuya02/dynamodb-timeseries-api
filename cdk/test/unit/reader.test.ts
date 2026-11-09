import { describe, expect, it } from 'vitest';
import { readRows, runWithConcurrency } from '../../lambda/api/reader';
import { parseQueryRequest } from '../../lambda/api/request';
import { base, fakeClient } from './helpers';

const T0 = Date.parse('2025-11-03T00:00:00Z');
const H = 3_600_000;

describe('readRows', () => {
  it('Query の条件: キー条件、プロジェクション、件数、RCU の取得', async () => {
    const d = base({ partitionKey: { name: 'pk', template: 'dev#{key}' }, fields: [{ name: 'value' }, { name: 'date', type: 'string' }] });
    const { client, calls } = fakeClient(() => ({ Items: [] }));
    await readRows(client, parseQueryRequest({ ds: d }, { dataset: 'ds', key: 'a', from: `${T0}`, to: `${T0 + H}` }));
    expect(calls).toEqual([
      {
        TableName: 'tbl',
        IndexName: undefined,
        KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
        ProjectionExpression: '#sk, #f0_0, #f1_0',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'ts', '#f0_0': 'value', '#f1_0': 'date' },
        ExpressionAttributeValues: { ':pk': 'dev#a', ':lo': T0, ':hi': T0 + H },
        ScanIndexForward: true,
        Limit: 50000,
        ExclusiveStartKey: undefined,
        ReturnConsumedCapacity: 'TOTAL',
      },
    ]);
  });

  it('LastEvaluatedKey がなくなるまでページを読み、RCU を合計する', async () => {
    const d = base();
    const { client, calls } = fakeClient((_input, call) => ({
      Items: [{ pk: 'a', ts: T0 + call, value: call }],
      LastEvaluatedKey: call < 2 ? { pk: 'a', ts: T0 + call } : undefined,
      ConsumedCapacity: { CapacityUnits: 0.5 },
    }));
    const r = await readRows(client, parseQueryRequest({ ds: d }, { dataset: 'ds', key: 'a', from: `${T0}`, to: `${T0 + H}` }));
    expect(r.rows.map((x) => x.values.value)).toEqual([0, 1, 2]);
    expect(r.meta).toEqual({ queries: 1, pages: 3, items: 3, truncated: false, consumedRcu: 1.5 });
    expect(calls[1].ExclusiveStartKey).toEqual({ pk: 'a', ts: T0 });
  });

  it.each([
    [{ maxItems: 2 }, 'maxItems', 2],
    [{ maxPages: 1 }, 'maxPages', 1],
    [{ maxRcu: 1 }, 'maxRcu', 2],
  ])('上限 %j に達したら次のページを読まずに打ち切る（truncatedBy: %s）', async (limits, by, pages) => {
    const d = base({ limits });
    const { client } = fakeClient((_input, call) => ({
      Items: [{ ts: T0 + call, value: call }],
      LastEvaluatedKey: { ts: T0 + call },
      ConsumedCapacity: { CapacityUnits: 0.5 },
    }));
    const r = await readRows(client, parseQueryRequest({ ds: d }, { dataset: 'ds', key: 'a', from: `${T0}`, to: `${T0 + H}` }));
    expect(r.meta).toMatchObject({ truncated: true, truncatedBy: by, pages });
  });

  it('範囲外と、時刻として読めない値は除く', async () => {
    const d = base({ sortKey: { name: 'ts', format: 'epoch_s' } });
    const { client } = fakeClient(() => ({ Items: [{ ts: T0 / 1000 }, { ts: (T0 + H) / 1000 + 1 }, { ts: 'x' }] }));
    const r = await readRows(client, parseQueryRequest({ ds: d }, { dataset: 'ds', key: 'a', from: `${T0}`, to: `${T0 + H}` }));
    expect(r.rows.map((x) => x.time)).toEqual([T0]);
    expect(r.meta.items).toBe(3);
  });

  it('latest は降順・10 件ずつ読み、新しい日付から順に、範囲内の 1 件が見つかった時点で止める', async () => {
    const d = base({ partitionKey: { name: 'pk', template: '{key}#{yyyy-MM-dd}', bucket: 'daily' } });
    const { client, calls } = fakeClient((input) =>
      input.ExpressionAttributeValues?.[':pk'] === 'a#2025-11-04' ? { Items: [{ ts: T0 + H }] } : { Items: [] },
    );
    const r = await readRows(client, parseQueryRequest({ ds: d }, { dataset: 'ds', key: 'a', from: `${T0}`, to: `${T0 + 3 * 24 * H - 1}`, latest: '1' }));
    expect(calls.map((c) => c.ExpressionAttributeValues?.[':pk'])).toEqual(['a#2025-11-05', 'a#2025-11-04']);
    expect(calls.every((c) => c.ScanIndexForward === false && c.Limit === 10)).toBe(true);
    expect(r.rows).toEqual([{ time: T0 + H, key: 'a', values: { value: null } }]);
  });

  it('複数のキーは時刻 → キーの順に並べる', async () => {
    const d = base();
    const { client } = fakeClient((input) => ({ Items: [{ ts: input.ExpressionAttributeValues?.[':pk'] === 'a' ? T0 + 1 : T0 }] }));
    const r = await readRows(client, parseQueryRequest({ ds: d }, { dataset: 'ds', key: 'a,b', from: `${T0}`, to: `${T0 + H}` }));
    expect(r.rows.map((x) => x.key)).toEqual(['b', 'a']);
  });
});

describe('runWithConcurrency', () => {
  it('同時に limit 個までしか実行しない', async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((ok) => setTimeout(ok, 1));
      running--;
    });
    await runWithConcurrency(tasks, 8);
    expect(peak).toBe(8);
  });
});
