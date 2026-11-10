import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi, errorResult, queryCacheKey, writeLog } from '../../lambda/api/app';
import { ResponseCache } from '../../lambda/api/cache';
import { ApiError } from '../../lambda/api/errors';
import { parseQueryRequest } from '../../lambda/api/request';
import type { LogLine } from '../../lambda/api/types';
import { base, fakeClient } from './helpers';

const T0 = Date.parse('2025-11-03T00:00:00Z');

function setup(respond: Parameters<typeof fakeClient>[0] = () => ({ Items: [{ ts: T0, value: 1 }] })) {
  const logs: LogLine[] = [];
  const { client, calls } = fakeClient(respond);
  let t = 1000;
  const api = createApi({ datasets: { ds: base() }, client, cache: new ResponseCache(), log: (l) => logs.push(l), now: () => (t += 5) });
  return { api, logs, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('createApi: /query', () => {
  const p = { dataset: 'ds', key: 'a', from: `${T0}`, to: `${T0 + 1000}` };

  it('応答に meta.cache を付け、2 回目はキャッシュから返す（DynamoDB は 1 回だけ）', async () => {
    const { api, calls } = setup();
    const a = await api.handle('/query', p);
    const b = await api.handle('/query', p);
    expect(a).toMatchObject({ status: 200, body: { rows: [{ time: T0, key: 'a', value: 1 }], meta: { cache: 'miss' } } });
    expect(b).toMatchObject({ status: 200, body: { meta: { cache: 'hit' } } });
    expect(calls).toHaveLength(1);
  });

  it('構造化ログ: 1 リクエスト 1 行、所要時間は注入した時計で測る', async () => {
    const { api, logs } = setup();
    await api.handle('/query', p);
    expect(logs).toEqual([
      expect.objectContaining({
        type: 'query',
        status: 200,
        dataset: 'ds',
        keys: 1,
        rangeMs: 1000,
        format: 'long',
        cache: 'miss',
        queries: 1,
        pages: 1,
        items: 1,
        points: 1,
        durationMs: 5,
      }),
    ]);
  });

  it('検証エラーは 400 とログの error', async () => {
    const { api, logs } = setup();
    const r = await api.handle('/query', { dataset: 'ds' });
    expect(r).toEqual({ status: 400, body: { error: 'Specify key (comma-separated for multiple keys)' } });
    expect(logs[0]).toMatchObject({ status: 400, error: 'Specify key (comma-separated for multiple keys)', cache: undefined });
  });

  it('DynamoDB のエラーは 500 とエラー名・内容', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api } = setup(() => {
      const e = new Error('Requested resource not found');
      e.name = 'ResourceNotFoundException';
      throw e;
    });
    expect(await api.handle('/query', p)).toEqual({ status: 500, body: { error: 'ResourceNotFoundException: Requested resource not found' } });
  });
});

describe('createApi: パスの振り分け', () => {
  it('/datasets、/keys、末尾のスラッシュ、ステージ名、未知のパス', async () => {
    const { api, logs } = setup();
    expect((await api.handle('/v1/datasets/', {})).status).toBe(200);
    const keys = await api.handle('/keys', { dataset: 'ds' });
    expect(keys).toEqual({ status: 200, body: [{ key: 'a' }, { key: 'b' }], headers: undefined });
    expect(await api.handle('/v1/foo', {})).toEqual({ status: 404, body: { error: 'The path must be /query, /datasets, or /keys' } });
    expect(logs.map((l) => l.type)).toEqual(['datasets', 'keys', 'unknown']);
  });

  it('/keys は一覧を作れない設定なら x-tsapi-hint ヘッダー', async () => {
    const { client } = fakeClient(() => ({}));
    const api = createApi({ datasets: { ds: base({ keys: { pattern: '.*' } }) }, client, log: () => {} });
    expect((await api.handle('/keys', { dataset: 'ds' })).headers).toEqual({ 'x-tsapi-hint': 'keys.values or keys.list is required to list keys' });
  });
});

describe('queryCacheKey / errorResult / writeLog', () => {
  it('キーの並び順だけが違うリクエストは同じキー', () => {
    const ds = { ds: base() };
    const a = parseQueryRequest(ds, { dataset: 'ds', key: 'a,b', from: '0', to: '1' });
    const b = parseQueryRequest(ds, { dataset: 'ds', key: 'b,a', from: '0', to: '1' });
    expect(queryCacheKey(a)).toBe(queryCacheKey(b));
  });

  it('ApiError はそのステータス', () => {
    expect(errorResult(new ApiError(404, 'x'))).toEqual({ status: 404, body: { error: 'x' } });
  });

  it('writeLog は stdout に 1 行の JSON を書く', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    writeLog({ type: 'query', n: 1 });
    expect(spy).toHaveBeenCalledWith('{"type":"query","n":1}\n');
  });
});
