// ---------------------------------------------------------------
// 一覧 API（Grafana のテンプレート変数用）
// Infinity の変数で読みやすいよう、どちらもルートを配列にする
// ---------------------------------------------------------------
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { ResolvedDataset } from '../../lib/config';
import { ApiError } from './errors';
import type { QueryClient } from './reader';
import { isAllowedKey } from './request';
import { columnName, getPath } from './transform';
import type { Datasets } from './types';

/** GET /datasets。テーブル名や属性名は返さない（Grafana の利用者にテーブルの内部構造を見せない） */
export function listDatasets(datasets: Datasets) {
  return Object.entries(datasets).map(([name, d]) => ({
    name,
    description: d.description ?? '',
    columns: d.fields.map((f) => ({ name: columnName(f), type: f.type, unit: f.unit })),
    maxRange: d.limits.maxRange,
    maxKeys: d.limits.maxKeys,
  }));
}

export interface KeyList {
  keys: { key: string }[];
  /** values: keys.values から / list: 登録用アイテムから / none: 一覧を作れない設定 */
  source: 'values' | 'list' | 'none';
  consumedRcu: number;
}

/** データセット名を検証して返す */
export function findDataset(datasets: Datasets, name: string | undefined): ResolvedDataset {
  if (!name) throw new ApiError(400, 'Specify dataset');
  const d = datasets[name];
  if (!d) throw new ApiError(404, `Dataset ${name} is not defined`);
  return d;
}

/** GET /keys?dataset=x。keys.values があればその値、keys.list があれば登録用アイテムから読む */
export async function listKeys(client: QueryClient, d: ResolvedDataset): Promise<KeyList> {
  if (d.keys.values) return keyList(d.keys.values, 'values');
  if (!d.keys.list) return keyList([], 'none');

  const { partitionValue, attribute } = d.keys.list;
  const parts = attribute.split('.');
  const names = Object.fromEntries([['#pk', d.partitionKey.name], ...parts.map((p, i) => [`#a${i}`, p])]);
  const keys: string[] = [];
  let rcu = 0;
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < d.limits.maxPages; page++) {
    const r = await client.send(
      new QueryCommand({
        TableName: d.table,
        IndexName: d.index,
        KeyConditionExpression: '#pk = :pk',
        ProjectionExpression: parts.map((_, i) => `#a${i}`).join('.'),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ':pk': partitionValue },
        ReturnConsumedCapacity: 'TOTAL',
        ExclusiveStartKey: start,
      }),
    );
    rcu += r.ConsumedCapacity?.CapacityUnits ?? 0;
    for (const item of r.Items ?? []) {
      const v = getPath(item, parts);
      // 登録用アイテムに書かれていても、/query で受け付けないキーは返さない（選ぶとエラーになるため）
      if (typeof v === 'string' && isAllowedKey(d, v)) keys.push(v);
    }
    start = r.LastEvaluatedKey;
    if (!start) break;
  }
  return keyList(keys, 'list', rcu);
}

const keyList = (keys: string[], source: KeyList['source'], consumedRcu = 0): KeyList => ({
  keys: [...new Set(keys)].sort().map((key) => ({ key })),
  source,
  consumedRcu,
});
