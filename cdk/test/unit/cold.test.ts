import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  type GetQueryResultsCommandOutput,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { describe, expect, it } from 'vitest';
import { createApi } from '../../lambda/api/app';
import { type AthenaRow, type AthenaRunner, createAthenaRunner } from '../../lambda/api/cold/athena';
import { createColdReader } from '../../lambda/api/cold/reader';
import { latestQuery, literal, rangeQuery } from '../../lambda/api/cold/sql';
import { ApiError } from '../../lambda/api/errors';
import { toResponse } from '../../lambda/api/response';
import { splitRange } from '../../lambda/api/split';
import { selectColumns } from '../../lambda/api/transform';
import type { QueryRequest } from '../../lambda/api/types';
import { base, fakeClient } from './helpers';

const M = 60_000;
const D = 86_400_000;
const NOW = Date.parse('2025-11-10T12:00:30Z');
const BOUNDARY = Date.parse('2025-11-03T12:00:00Z'); // NOW − 7d を 1 分に切り捨て
const table = { database: 'tsapi', table: 'cold' };

const d = base({
  fields: [{ name: 'value' }, { name: 'state', type: 'string' }],
  cold: {},
});
const req = (over: Partial<QueryRequest> = {}): QueryRequest => ({
  name: 'ds',
  dataset: d,
  keys: ['a'],
  from: BOUNDARY - 2 * D,
  to: NOW,
  columns: selectColumns(d, undefined),
  agg: 'avg',
  latest: false,
  format: 'long',
  tz: 'UTC',
  ...over,
});

/** 実行した SQL を記録し、用意した行を返す偽の Athena */
function fakeRunner(rows: AthenaRow[] = []) {
  const calls: { sql: string; params: string[] }[] = [];
  const runner: AthenaRunner = {
    async run(sql, params) {
      calls.push({ sql, params });
      return { rows, bytesScanned: 1234, engineMs: 56 };
    },
  };
  return { runner, calls };
}

describe('splitRange', () => {
  it('cold がなければすべてホット', () => {
    expect(splitRange(req({ dataset: base() }), NOW)).toEqual({ hot: { from: BOUNDARY - 2 * D, to: NOW } });
  });

  it('境界（現在 − hotRetention、1 分単位）で分ける', () => {
    expect(splitRange(req(), NOW)).toEqual({ cold: { from: BOUNDARY - 2 * D, to: BOUNDARY - 1 }, hot: { from: BOUNDARY, to: NOW } });
  });

  it('境界以降だけならホット、境界より前だけならコールド', () => {
    expect(splitRange(req({ from: BOUNDARY }), NOW)).toEqual({ hot: { from: BOUNDARY, to: NOW } });
    expect(splitRange(req({ to: BOUNDARY - 1 }), NOW)).toEqual({ cold: { from: BOUNDARY - 2 * D, to: BOUNDARY - 1 } });
  });
});

describe('SQL', () => {
  const f = { dataset: 'ds', keys: ["it's"], fields: ['value'], from: Date.parse('2025-11-01T23:00:00Z'), to: Date.parse('2025-11-02T01:00:00Z') };

  it('パーティション（dataset、dt）で絞り、キーと列名はパラメータで渡す', () => {
    const q = rangeQuery(table, { ...f, interval: 5 * M, offset: 9 * 3_600_000, limit: 100 });
    expect(q.sql).toContain(`dataset = 'ds' AND dt BETWEEN '2025-11-01' AND '2025-11-02' AND key IN (?) AND field IN (?) AND ts BETWEEN ${f.from} AND ${f.to}`);
    expect(q.sql).toContain('(ts + 32400000) / 300000 * 300000 - 32400000 AS t');
    expect(q.sql).toContain('FROM "tsapi"."cold"');
    expect(q.sql).toContain('LIMIT 100');
    expect(q.params).toEqual(["'it''s'", "'value'"]);
  });

  it('最新値はキー × 列ごとの最後の値', () => {
    expect(latestQuery(table, f).sql).toContain('max_by(val_last, last_ts)');
  });

  it('名前に使えない文字はエラー', () => {
    expect(() => rangeQuery({ database: 'a"b', table: 'c' }, { ...f, interval: M, offset: 0, limit: 1 })).toThrow();
    expect(literal("a'b")).toBe("'a''b'");
  });
});

describe('createColdReader', () => {
  const rows: AthenaRow[] = [
    { key: 'a', field: 'value', t: `${BOUNDARY - D}`, cnt: '2', val_sum: '10', val_min: '4', val_max: '6', val_last: '6', last_ts: `${BOUNDARY - D + M}` },
    { key: 'a', field: 'state', t: `${BOUNDARY - D}`, cnt: '2', text_last: 'on', last_ts: `${BOUNDARY - D + M}` },
  ];

  it('区切りごとの途中集計にする', async () => {
    const { runner, calls } = fakeRunner(rows);
    const r = await createColdReader(runner, table).read(req({ interval: D }), BOUNDARY - 2 * D, BOUNDARY - 1);
    expect(r.buckets).toEqual([
      {
        time: BOUNDARY - D,
        key: 'a',
        values: {
          value: { cnt: 2, sum: 10, min: 4, max: 6, last: 6, lastTs: BOUNDARY - D + M },
          state: { cnt: 2, sum: 0, min: 0, max: 0, last: 'on', lastTs: BOUNDARY - D + M },
        },
      },
    ]);
    expect(r.meta).toEqual({ from: BOUNDARY - 2 * D, to: BOUNDARY - 1, rows: 2, bytesScanned: 1234, engineMs: 56, truncated: false });
    expect(calls[0].sql).toContain('/ 86400000 * 86400000');
  });

  it('maxItems を超えたら打ち切る', async () => {
    const { runner, calls } = fakeRunner(rows);
    const r = await createColdReader(runner, table).read(req({ interval: D, dataset: { ...d, limits: { ...d.limits, maxItems: 1 } } }), 0, 1);
    expect(calls[0].sql).toContain('LIMIT 2');
    expect(r.meta.truncated).toBe(true);
    expect(r.buckets[0].values.state).toBeUndefined();
  });

  it('latest はキーごとに 1 行', async () => {
    const { runner } = fakeRunner([
      { key: 'a', field: 'value', val_last: '6', last_ts: '200' },
      { key: 'a', field: 'state', text_last: 'on', last_ts: '100' },
    ]);
    const r = await createColdReader(runner, table).read(req({ latest: true }), 0, 1);
    expect(r.rows).toEqual([{ time: 200, key: 'a', values: { value: 6, state: 'on' } }]);
  });
});

describe('toResponse（ホット + コールド）', () => {
  const hotMeta = { queries: 1, pages: 1, items: 2, truncated: false, consumedRcu: 0.5 };
  const cold = {
    buckets: [
      { time: BOUNDARY - D, key: 'a', values: { value: { cnt: 2, sum: 10, min: 4, max: 6, last: 6, lastTs: BOUNDARY - D } } },
      // 境界をまたぐ区切り（BOUNDARY が属する日）のコールド側
      { time: BOUNDARY - 12 * 3_600_000, key: 'a', values: { value: { cnt: 1, sum: 1, min: 1, max: 1, last: 1, lastTs: BOUNDARY - M } } },
    ],
    rows: [],
    meta: { from: BOUNDARY - 2 * D, to: BOUNDARY - 1, rows: 2, bytesScanned: 1234, engineMs: 56, truncated: false },
  };
  const hot = { rows: [{ time: BOUNDARY, key: 'a', values: { value: 3 } }], meta: hotMeta };

  it('同じ区切りはコールドとホットを足し合わせ、1 本の系列にする', () => {
    const r = toResponse(req({ interval: D, columns: selectColumns(d, 'value') }), hot, cold);
    expect(r.rows).toEqual([
      { time: BOUNDARY - D - 12 * 3_600_000, key: 'a', value: 5 },
      { time: BOUNDARY - 12 * 3_600_000, key: 'a', value: 2 }, // (1 + 3) / 2
    ]);
    expect(r.meta.cold).toEqual(cold.meta);
    expect(r.meta.consumedRcu).toBe(0.5);
  });

  it('count はコールドの件数を足す', () => {
    const r = toResponse(req({ interval: D, agg: 'count', columns: selectColumns(d, 'value') }), hot, cold);
    expect(r.rows.map((x) => x.value)).toEqual([2, 2]);
  });

  it('生データでは、コールドの範囲は 1 分の平均', () => {
    const r = toResponse(req({ columns: selectColumns(d, 'value') }), hot, cold);
    expect(r.rows).toEqual([
      { time: BOUNDARY - D, key: 'a', value: 5 },
      { time: BOUNDARY - 12 * 3_600_000, key: 'a', value: 1 },
      { time: BOUNDARY, key: 'a', value: 3 },
    ]);
  });

  it('コールドだけでも返す（DynamoDB は読んでいない）', () => {
    const r = toResponse(req({ interval: D, columns: selectColumns(d, 'value') }), undefined, cold);
    expect(r.meta).toMatchObject({ queries: 0, items: 0, points: 2 });
  });

  it('コールドの打ち切りは truncatedBy: maxItems', () => {
    const r = toResponse(req({ interval: D }), hot, { ...cold, meta: { ...cold.meta, truncated: true } });
    expect(r.meta).toMatchObject({ truncated: true, truncatedBy: 'maxItems' });
  });
});

describe('createApi（コールドあり）', () => {
  const params = { dataset: 'ds', key: 'a,b', from: `${BOUNDARY - 2 * D}`, to: `${NOW}` };
  const setup = (items: Record<string, unknown>[]) => {
    const { client, calls } = fakeClient((input) => ({ Items: items.filter((i) => i.pk === input.ExpressionAttributeValues?.[':pk']) }));
    const { runner, calls: sql } = fakeRunner([{ key: 'b', field: 'value', val_last: '9', last_ts: `${BOUNDARY - D}` }]);
    const api = createApi({ datasets: { ds: d }, client, cold: createColdReader(runner, table), log: () => {}, now: () => NOW });
    return { api, calls, sql };
  };

  it('DynamoDB は境界以降だけを読み、コールドは境界より前を読む', async () => {
    const { api, calls, sql } = setup([]);
    const r = await api.handle('/query', { ...params, interval: '1d' });
    expect(r.status).toBe(200);
    expect(calls.map((c) => c.ExpressionAttributeValues?.[':lo'])).toEqual([BOUNDARY, BOUNDARY]);
    expect(sql[0].sql).toContain(`ts BETWEEN ${Date.parse('2025-11-01T00:00:00Z')} AND ${BOUNDARY - 1}`);
  });

  it('latest はホットで見つからなかったキーだけコールドを読む', async () => {
    const { api, sql } = setup([{ pk: 'a', ts: NOW - M, value: 1 }]);
    const r = await api.handle('/query', { ...params, latest: '1' });
    expect(sql[0].params).toEqual(["'b'", "'value'", "'state'"]);
    expect((r.body as { rows: unknown[] }).rows).toEqual([
      { time: BOUNDARY - D, key: 'b', value: 9, state: null },
      { time: NOW - M, key: 'a', value: 1, state: null },
    ]);
  });

  it('コールドの読み込みがなければ DynamoDB だけを読む', async () => {
    const { client, calls } = fakeClient(() => ({ Items: [] }));
    const api = createApi({ datasets: { ds: d }, client, log: () => {}, now: () => NOW });
    await api.handle('/query', params);
    expect(calls[0].ExpressionAttributeValues?.[':lo']).toBe(BOUNDARY - 2 * D);
  });

  it('cold のデータセットは cold.maxRange（既定 400d）で期間を確かめる', async () => {
    const { api } = setup([]);
    expect((await api.handle('/query', { ...params, from: `${NOW - 100 * D}` })).status).toBe(200);
    expect(await api.handle('/query', { ...params, from: `${NOW - 401 * D}` })).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('cold.maxRange') },
    });
  });
});

describe('createAthenaRunner', () => {
  const page = (rows: (string | undefined)[][], token?: string): Partial<GetQueryResultsCommandOutput> => ({
    ResultSet: { Rows: rows.map((r) => ({ Data: r.map((v) => ({ VarCharValue: v })) })) },
    NextToken: token,
  });

  function fakeAthena(states: string[], pages: Partial<GetQueryResultsCommandOutput>[] = []) {
    const sent: unknown[] = [];
    let s = 0;
    let p = 0;
    const client = {
      async send(c: unknown): Promise<unknown> {
        sent.push(c);
        if (c instanceof StartQueryExecutionCommand) return { QueryExecutionId: 'q1' };
        if (c instanceof GetQueryExecutionCommand) {
          const state = states[Math.min(s++, states.length - 1)];
          return {
            QueryExecution: { Status: { State: state, StateChangeReason: 'boom' }, Statistics: { DataScannedInBytes: 10, EngineExecutionTimeInMillis: 20 } },
          };
        }
        if (c instanceof GetQueryResultsCommand) return pages[p++];
        return {};
      },
    };
    return { client: client as never, sent };
  }

  it('完了まで待ち、結果をページングで読む（1 行目は列名）', async () => {
    const { client, sent } = fakeAthena(
      ['RUNNING', 'SUCCEEDED'],
      [
        page(
          [
            ['key', 'cnt'],
            ['a', '1'],
          ],
          't',
        ),
        page([['b', undefined]]),
      ],
    );
    const r = await createAthenaRunner(client, { workgroup: 'wg', database: 'db', sleep: async () => {} }).run('SELECT 1', ["'a'"]);
    expect(r).toEqual({
      rows: [
        { key: 'a', cnt: '1' },
        { key: 'b', cnt: undefined },
      ],
      bytesScanned: 10,
      engineMs: 20,
    });
    expect((sent[0] as StartQueryExecutionCommand).input).toEqual({
      QueryString: 'SELECT 1',
      ExecutionParameters: ["'a'"],
      WorkGroup: 'wg',
      QueryExecutionContext: { Database: 'db' },
    });
  });

  it('失敗したら理由つきの 502', async () => {
    const { client } = fakeAthena(['FAILED']);
    await expect(createAthenaRunner(client, { workgroup: 'wg', database: 'db' }).run('x', [])).rejects.toThrow(/boom/);
  });

  it('時間内に終わらなければクエリを止めて 504', async () => {
    const { client, sent } = fakeAthena(['RUNNING']);
    let t = 0;
    const runner = createAthenaRunner(client, {
      workgroup: 'wg',
      database: 'db',
      timeoutMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    const e = await runner.run('x', []).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(504);
    expect(sent.some((c) => c instanceof StopQueryExecutionCommand)).toBe(true);
  });
});
