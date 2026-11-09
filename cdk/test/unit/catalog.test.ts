import { describe, expect, it } from 'vitest';
import { findDataset, listDatasets, listKeys } from '../../lambda/api/catalog';
import { ApiError } from '../../lambda/api/errors';
import { base, fakeClient } from './helpers';

describe('listDatasets', () => {
  it('名前、説明、列、上限だけを返す（テーブル名・属性名は返さない）', () => {
    const d = base({ description: '説明', fields: [{ name: 'meta.fw', type: 'string', unit: 'v' }] });
    expect(listDatasets({ ds: d })).toEqual([
      { name: 'ds', description: '説明', columns: [{ name: 'meta_fw', type: 'string', unit: 'v' }], maxRange: '31d', maxKeys: 20 },
    ]);
  });
});

describe('findDataset', () => {
  it('dataset がなければ 400、未定義なら 404', () => {
    expect(() => findDataset({}, undefined)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => findDataset({}, 'x')).toThrow(ApiError);
    expect(() => findDataset({}, 'x')).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('listKeys', () => {
  it('keys.values があればその値（DynamoDB は読まない）', async () => {
    const { client, calls } = fakeClient(() => ({}));
    expect(await listKeys(client, base({ keys: { values: ['b', 'a'] } }))).toEqual({ keys: [{ key: 'a' }, { key: 'b' }], source: 'values', consumedRcu: 0 });
    expect(calls).toHaveLength(0);
  });

  it('keys.list の登録用アイテムをページングして読み、許可されないキー・文字列以外・重複を除く', async () => {
    const d = base({ keys: { pattern: '^[a-z]$', list: { partitionValue: 'devices', attribute: 'info.id' } } });
    const { client, calls } = fakeClient((_input, call) =>
      call === 0
        ? {
            Items: [{ info: { id: 'b' } }, { info: { id: 'BAD' } }, { info: { id: 1 } }],
            LastEvaluatedKey: { pk: 'devices' },
            ConsumedCapacity: { CapacityUnits: 0.5 },
          }
        : { Items: [{ info: { id: 'a' } }, { info: { id: 'b' } }, {}], ConsumedCapacity: { CapacityUnits: 0.5 } },
    );
    expect(await listKeys(client, d)).toEqual({ keys: [{ key: 'a' }, { key: 'b' }], source: 'list', consumedRcu: 1 });
    expect(calls[0]).toMatchObject({
      KeyConditionExpression: '#pk = :pk',
      ProjectionExpression: '#a0.#a1',
      ExpressionAttributeNames: { '#pk': 'pk', '#a0': 'info', '#a1': 'id' },
      ExpressionAttributeValues: { ':pk': 'devices' },
    });
  });

  it('keys.list の読み込みも maxPages で止める', async () => {
    const d = base({ keys: { pattern: '.*', list: { partitionValue: 'p', attribute: 'id' } }, limits: { maxPages: 2 } });
    const { client, calls } = fakeClient(() => ({ Items: [], LastEvaluatedKey: { pk: 'p' } }));
    await listKeys(client, d);
    expect(calls).toHaveLength(2);
  });

  it('どちらもなければ空（source: none）', async () => {
    const { client } = fakeClient(() => ({}));
    expect((await listKeys(client, base({ keys: { pattern: '.*' } }))).source).toBe('none');
  });
});
