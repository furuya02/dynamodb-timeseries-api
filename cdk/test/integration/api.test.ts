// API 全体: キャッシュ、構造化ログ、応答サイズ、一覧 API、パス（DynamoDB Local）
import { describe, expect, it } from 'vitest';
import { H, T0 } from './fixtures';
import { datasets, newApi, type QueryBody } from './helpers';

describe('応答キャッシュ', () => {
  const base = { dataset: 'agg', key: 'a,b', from: `${T0}`, to: `${T0 + 24 * H - 1}`, interval: '1h' };

  it('同じ問い合わせは 2 回目からキャッシュ。キーの順序が違っても、区切りが同じなら 1 分ずれても当たる', async () => {
    const { api } = newApi();
    const q = async (p: Record<string, string>) => (await api.handle('/query', p)).body as QueryBody;
    const c1 = await q(base);
    const c2 = await q(base);
    expect([c1.meta.cache, c2.meta.cache]).toEqual(['miss', 'hit']);
    expect(c2.rows).toEqual(c1.rows);
    expect((await q({ ...base, key: 'b,a' })).meta.cache).toBe('hit');
    const shifted = await q({ ...base, from: `${T0 + 60_000}`, to: `${T0 + 24 * H - 60_001}` });
    expect(shifted.meta.cache).toBe('hit');
    expect(shifted.rows).toHaveLength(48);
    expect((await q({ ...base, interval: '30m' })).meta.cache).toBe('miss');
  });

  it('生データは丸めないので、1 ミリ秒ずれるとキャッシュに当たらない', async () => {
    const { api } = newApi();
    const raw = { dataset: 'agg', key: 'a', from: `${T0}`, to: `${T0 + H}` };
    await api.handle('/query', raw);
    expect(((await api.handle('/query', { ...raw, to: `${T0 + H + 1}` })).body as QueryBody).meta.cache).toBe('miss');
  });

  it('cacheTtlSeconds を過ぎると読み直し、0 なら保持しない', async () => {
    const { api } = newApi();
    const short = { dataset: 'cache_short', key: 'a', from: `${T0}`, to: `${T0 + H}` };
    const cacheOf = async (p: Record<string, string>) => ((await api.handle('/query', p)).body as QueryBody).meta.cache;
    expect(await cacheOf(short)).toBe('miss');
    expect(await cacheOf(short)).toBe('hit');
    await new Promise((ok) => setTimeout(ok, 1100));
    expect(await cacheOf(short)).toBe('miss');
    const off = { dataset: 'cache_off', key: 'a', from: `${T0}`, to: `${T0 + H}` };
    await cacheOf(off);
    expect(await cacheOf(off)).toBe('miss');
  });
});

describe('エラーと構造化ログ', () => {
  it('検証エラーは 400 と理由、DynamoDB のエラーは 500 とエラー名・内容', async () => {
    const { api } = newApi();
    const e400 = await api.handle('/query', { dataset: 'agg' });
    expect(e400.status).toBe(400);
    expect(JSON.stringify(e400.body)).toContain('Specify key');
    const e500 = await api.handle('/query', { dataset: 'wrong_type', key: 'room-01', from: `${T0}`, to: `${T0 + H}` });
    expect(e500.status).toBe(500);
    expect(JSON.stringify(e500.body)).toContain('ValidationException');
  });

  it('1 リクエスト = 1 行。キャッシュに当たったときは件数と RCU を出さない', async () => {
    const { api, logs } = newApi();
    const p = { dataset: 'agg', key: 'a,b', from: `${T0}`, to: `${T0 + 2 * H}`, interval: '5m', agg: 'max' };
    await api.handle('/query', p);
    await api.handle('/query', p);
    await api.handle('/query', { dataset: 'agg', key: 'zzz', from: '0', to: '1' });
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ type: 'query', status: 200, cache: 'miss', keys: 2, agg: 'max', points: 18 });
    expect(logs[0].consumedRcu).toEqual(expect.any(Number));
    expect(logs[0].durationMs).toEqual(expect.any(Number));
    expect(logs[1]).toMatchObject({ cache: 'hit', items: undefined, consumedRcu: undefined });
    expect(logs[2]).toMatchObject({ status: 400, error: expect.stringContaining('zzz') });
  });

  it('応答が上限を超えると、502 になる前に理由つきの 400 にする（集計すれば返る）', async () => {
    const { api } = newApi();
    const p = { dataset: 'paging_huge', key: 'huge', from: `${T0}`, to: `${T0 + 6_000_000}` };
    const huge = await api.handle('/query', p);
    expect(huge.status).toBe(400);
    expect(JSON.stringify(huge.body)).toContain('The response is too large');
    expect((await api.handle('/query', { ...p, interval: '10m', agg: 'count' })).status).toBe(200);
  });
});

describe('一覧 API', () => {
  it('/datasets はデータセットの一覧。テーブル名・属性名は含まない', async () => {
    const { api } = newApi();
    const r = await api.handle('/datasets', {});
    const list = r.body as { name: string; columns: { name: string; unit?: string }[] }[];
    expect(r.status).toBe(200);
    expect(list).toHaveLength(Object.keys(datasets).length);
    expect(JSON.stringify(list)).not.toContain('t-epoch-ms');
    expect(JSON.stringify(list)).not.toContain('"deviceId"');
    const tr = list.find((x) => x.name === 'transform');
    expect(tr?.columns.slice(0, 3)).toEqual([
      { name: 'temp_c', type: 'number', unit: 'celsius' },
      { name: 'humidity', type: 'number', unit: 'percent' },
      { name: 'meta_fw', type: 'string' },
    ]);
  });

  it('/keys は keys.values をそのまま返す', async () => {
    const { api } = newApi();
    expect((await api.handle('/keys', { dataset: 'iso_prefix' })).body).toEqual([{ key: 'a' }, { key: 'b' }]);
  });

  it('/keys は keys.list の登録用アイテムから読み、pattern に合わないもの・属性がないもの・重複を除く。2 回目はキャッシュ', async () => {
    const { api, logs } = newApi();
    expect((await api.handle('/keys', { dataset: 'list_keys' })).body).toEqual([{ key: 'a' }, { key: 'b' }]);
    await api.handle('/keys', { dataset: 'list_keys' });
    expect(logs.map((l) => l.cache)).toEqual(['miss', 'hit']);
  });

  it('/keys の keys.list はネスト属性も読める', async () => {
    const { api } = newApi();
    expect((await api.handle('/keys', { dataset: 'list_nested' })).body).toEqual([{ key: 'x' }]);
  });

  it('/keys は一覧を作れない設定（pattern だけ）なら、空の配列と理由のヘッダー', async () => {
    const { api } = newApi();
    const r = await api.handle('/keys', { dataset: 'epoch_ms' });
    expect(r.body).toEqual([]);
    expect(r.headers?.['x-tsapi-hint']).toBeDefined();
  });

  it('/keys は dataset がなければ 400、未定義なら 404', async () => {
    const { api } = newApi();
    expect((await api.handle('/keys', {})).status).toBe(400);
    expect((await api.handle('/keys', { dataset: 'nope' })).status).toBe(404);
  });
});

describe('パス', () => {
  it('ステージ名付き（/v1/query）や末尾のスラッシュ（/datasets/）も受け、未知のパスは 404', async () => {
    const { api } = newApi();
    expect((await api.handle('/v1/query', { dataset: 'iso_prefix', key: 'a', from: `${T0}`, to: `${T0 + H}` })).status).toBe(200);
    expect((await api.handle('/datasets/', {})).status).toBe(200);
    expect((await api.handle('/v1/foo', {})).status).toBe(404);
  });
});
