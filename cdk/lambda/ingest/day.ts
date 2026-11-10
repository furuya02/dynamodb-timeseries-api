// ---------------------------------------------------------------
// 1 日分（UTC）の取り込み: DynamoDB を Query で読む → 1 分の集計 → Parquet → S3
// 同じ日を何度取り込んでも結果が同じになるよう、日付のフォルダの中身を置き換える
// ---------------------------------------------------------------
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { ResolvedDataset } from '../../lib/config';
import { listKeys } from '../api/catalog';
import { COLD_DATA_PREFIX } from '../api/cold/sql';
import { type QueryClient, readRows } from '../api/reader';
import { selectColumns } from '../api/transform';
import type { QueryRequest } from '../api/types';
import { type ColdRecord, rollup, toParquet } from './rollup';

/** 取り込みでは件数などの上限で打ち切らない（1 キー × 1 日ずつ読むので、メモリに収まる量に限られる） */
const NO_LIMITS = { maxItems: 1_000_000_000, maxPages: Number.POSITIVE_INFINITY, maxRcu: Number.POSITIVE_INFINITY };

const DAY_MS = 86_400_000;

export interface IngestTarget {
  s3: Pick<S3Client, 'send'>;
  bucket: string;
}

export interface DayResult {
  dataset: string;
  date: string;
  keys: number;
  items: number;
  records: number;
  bytes: number;
  consumedRcu: number;
}

export const partitionPrefix = (dataset: string, date: string): string => `${COLD_DATA_PREFIX}dataset=${dataset}/dt=${date}/`;

/** 日付（yyyy-MM-dd、UTC）を検証して、その日の範囲（UNIX ミリ秒、両端を含む）を返す */
export function dayRange(date: string): { from: number; to: number } {
  const from = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(from)) throw new Error(`Specify the date as yyyy-MM-dd: ${date}`);
  return { from, to: from + DAY_MS - 1 };
}

/** キーの一覧（keys.values か keys.list）。Scan はしないので、どちらもない場合はエラー */
export async function ingestKeys(client: QueryClient, d: ResolvedDataset): Promise<string[]> {
  const list = await listKeys(client, { ...d, limits: { ...d.limits, ...NO_LIMITS } });
  if (list.source === 'none') throw new Error('Ingesting into cold storage requires keys.values or keys.list (no Scan is used)');
  return list.keys.map((k) => k.key);
}

/** DynamoDB から 1 日分を読み、1 分の集計にする */
export async function readDay(client: QueryClient, name: string, d: ResolvedDataset, keys: string[], date: string) {
  const { from, to } = dayRange(date);
  const columns = selectColumns(d, undefined);
  const dataset = { ...d, limits: { ...d.limits, ...NO_LIMITS } };
  const records: ColdRecord[] = [];
  let items = 0;
  let consumedRcu = 0;
  for (const key of keys) {
    const req: QueryRequest = { name, dataset, keys: [key], from, to, columns, agg: 'avg', latest: false, format: 'long', tz: 'UTC' };
    const r = await readRows(client, req);
    items += r.meta.items;
    consumedRcu += r.meta.consumedRcu;
    records.push(...rollup(r.rows, columns));
  }
  return { records, items, consumedRcu };
}

/**
 * 1 日分の集計を S3 に書く。先に新しいファイルを書いてから、同じフォルダの他のファイルを消す（読めない時間を作らない）。
 * 集計が 0 件なら、フォルダを空にする
 */
export async function writeDay(t: IngestTarget, dataset: string, date: string, records: ColdRecord[]): Promise<number> {
  const prefix = partitionPrefix(dataset, date);
  const name = `${prefix}part-0.parquet`;
  let bytes = 0;
  if (records.length > 0) {
    const body = toParquet(records);
    bytes = body.byteLength;
    await t.s3.send(new PutObjectCommand({ Bucket: t.bucket, Key: name, Body: body, ContentType: 'application/vnd.apache.parquet' }));
  }
  const listed = await t.s3.send(new ListObjectsV2Command({ Bucket: t.bucket, Prefix: prefix }));
  const stale = (listed.Contents ?? []).map((o) => o.Key as string).filter((k) => records.length === 0 || k !== name);
  if (stale.length > 0) await t.s3.send(new DeleteObjectsCommand({ Bucket: t.bucket, Delete: { Objects: stale.map((Key) => ({ Key })) } }));
  return bytes;
}

/** 1 データセット × 1 日を取り込む */
export async function ingestDay(client: QueryClient, t: IngestTarget, name: string, d: ResolvedDataset, date: string, keys?: string[]): Promise<DayResult> {
  const ks = keys ?? (await ingestKeys(client, d));
  const { records, items, consumedRcu } = await readDay(client, name, d, ks, date);
  const bytes = await writeDay(t, name, date, records);
  return { dataset: name, date, keys: ks.length, items, records: records.length, bytes, consumedRcu };
}
