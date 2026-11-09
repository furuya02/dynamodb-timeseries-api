// ---------------------------------------------------------------
// ストリームのアイテムが、どのデータセットのどのキー・時刻にあたるかを判定する
// パーティションキーの値をテンプレート（room#{key}、{key}#{yyyy-MM-dd} など）と突き合わせてキーを取り出す
// ---------------------------------------------------------------
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import type { ResolvedDataset } from '../../lib/config';
import { readTime } from '../api/key-condition';
import { isAllowedKey } from '../api/request';
import { selectColumns, toValues } from '../api/transform';
import type { Datasets, Row } from '../api/types';
import { rollup } from './rollup';

const templates = new Map<string, RegExp>();

/** テンプレート → 正規表現（{key} を取り出し、日付の部分は形式だけ確かめる） */
export function templateRegex(template: string): RegExp {
  let re = templates.get(template);
  if (!re) {
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped
      .replace('\\{key\\}', '(?<key>.+?)')
      .replaceAll('\\{key\\}', '\\k<key>')
      .replaceAll('\\{yyyy-MM-dd\\}', '\\d{4}-\\d{2}-\\d{2}')
      .replaceAll('\\{yyyy-MM\\}', '\\d{4}-\\d{2}');
    re = new RegExp(`^${pattern}$`);
    templates.set(template, re);
  }
  return re;
}

/** 1 つのアイテムをデータセットの行にする。データセットのアイテムでなければ undefined */
export function matchItem(d: ResolvedDataset, item: Record<string, unknown>): Row | undefined {
  const pk = item[d.partitionKey.name];
  const sk = item[d.sortKey.name];
  if (typeof pk !== 'string' || sk === undefined) return undefined;
  const key = templateRegex(d.partitionKey.template).exec(pk)?.groups?.key;
  if (key === undefined || !isAllowedKey(d, key)) return undefined;
  if (d.sortKey.prefix && !(typeof sk === 'string' && sk.startsWith(d.sortKey.prefix))) return undefined;
  const time = readTime(d, sk);
  if (!Number.isFinite(time)) return undefined;
  return { time, key, values: toValues(item, selectColumns(d, undefined)) };
}

/** テーブル名 → そのテーブルを読む cold のデータセット名 */
export function datasetsByTable(datasets: Datasets): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, d] of Object.entries(datasets)) {
    if (!d.cold) continue;
    out.set(d.table, [...(out.get(d.table) ?? []), name]);
  }
  return out;
}

/** ストリームのレコード → Firehose に送る JSON（dataset と dt は Firehose がパーティションを決めるのに使う） */
export function toFirehoseRecords(ds: Datasets, tables: Map<string, string[]>, event: DynamoDBStreamEvent): Record<string, unknown>[] {
  const rows = new Map<string, Row[]>();
  for (const r of event.Records) {
    const image = r.dynamodb?.NewImage;
    const table = r.eventSourceARN?.split(':table/')[1]?.split('/')[0];
    if (r.eventName !== 'INSERT' || !image || !table) continue;
    const item = unmarshall(image as never);
    for (const name of tables.get(table) ?? []) {
      const row = matchItem(ds[name], item);
      if (row) rows.set(name, [...(rows.get(name) ?? []), row]);
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, rs] of rows) {
    for (const rec of rollup(rs, selectColumns(ds[name], undefined))) out.push({ ...rec, dataset: name, dt: new Date(rec.ts).toISOString().slice(0, 10) });
  }
  return out;
}
