// ---------------------------------------------------------------
// /query のパラメータの検証
// ---------------------------------------------------------------
import type { ResolvedDataset } from '../../lib/config';
import { ApiError } from './errors';
import { bucketStart, isTimezone, parseDuration } from './time';
import { selectColumns } from './transform';
import { AGGS, type Agg, type Datasets, FORMATS, type Format, type QueryRequest } from './types';

export interface QueryParams {
  dataset?: string;
  key?: string;
  from?: string;
  to?: string;
  fields?: string;
  interval?: string;
  agg?: string;
  latest?: string;
  format?: string;
  tz?: string;
}

const UNRESOLVED = /\$\{|\$__/;

/** クエリパラメータを検証し、問い合わせに使う形にする。誤りは理由つきの ApiError（400 / 404） */
export function parseQueryRequest(datasets: Datasets, p: QueryParams): QueryRequest {
  rejectUnresolvedVariables(p);
  const name = requireValue(p.dataset, 'Specify dataset');
  const dataset = datasets[name];
  if (!dataset) throw new ApiError(404, `Dataset ${name} is not defined`);

  const keys = parseKeys(dataset, p.key);
  const from = parseTime(p.from, 'from');
  const to = parseTime(p.to, 'to');
  if (from > to) throw new ApiError(400, 'from must be earlier than or equal to to');
  // コールドストアを読むデータセットでは、DynamoDB を読む期間は hotRetention までに収まるため cold.maxRange を使う
  const [rangeText, rangeName] = dataset.cold ? [dataset.cold.maxRange, 'cold.maxRange'] : [dataset.limits.maxRange, 'limits.maxRange'];
  const maxRange = parseDuration(rangeText) ?? Number.POSITIVE_INFINITY;
  if (to - from > maxRange) throw new ApiError(400, `The time range is too long. Keep it within ${rangeText} (${rangeName})`);

  const interval = p.interval === undefined || p.interval === '' ? undefined : parseInterval(p.interval);
  const agg = parseAgg(p.agg, interval);
  const latest = parseLatest(p.latest);
  if (latest && interval !== undefined) throw new ApiError(400, 'latest and interval cannot be used together');
  const format = parseFormat(p.format);
  const tz = p.tz ?? defaultTimezone(dataset);
  if (!isTimezone(tz)) throw new ApiError(400, 'tz must be UTC, an offset such as +09:00, or an IANA name such as Asia/Tokyo');

  // 集計するときは from / to を区切りに合わせて丸める。先頭の区切りも欠けずにそろい、
  // Grafana の自動更新で少しずつずれた時刻でもキャッシュに当たる
  const range = interval === undefined ? { from, to } : { from: bucketStart(from, interval, tz), to: bucketStart(to, interval, tz) + interval - 1 };

  return { name, dataset, keys, ...range, columns: selectColumns(dataset, p.fields), interval, agg, latest, format, tz };
}

/**
 * Grafana の変数が置き換わらずに届いた場合。
 * アラートはバックエンドで評価され、ダッシュボードの変数と $__interval_ms は置き換わらない
 */
function rejectUnresolvedVariables(p: QueryParams): void {
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string' && UNRESOLVED.test(v)) {
      throw new ApiError(
        400,
        `${k}=${v}: a Grafana variable was not replaced. Alert queries cannot use dashboard variables or $__interval_ms (write the key values directly, and use a fixed interval such as 5m or latest=1)`,
      );
    }
  }
}

function requireValue(v: string | undefined, message: string): string {
  if (!v) throw new ApiError(400, message);
  return v;
}

/** Grafana の複数選択変数は ${key:csv} で "a,b,c" として渡す。重複と空白は除く */
function parseKeys(d: ResolvedDataset, param: string | undefined): string[] {
  const keys = [
    ...new Set(
      (param ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
  if (keys.length === 0) throw new ApiError(400, 'Specify key (comma-separated for multiple keys)');
  if (keys.length > d.limits.maxKeys) throw new ApiError(400, `Up to ${d.limits.maxKeys} keys can be specified (limits.maxKeys)`);
  for (const k of keys) {
    if (!isAllowedKey(d, k)) throw new ApiError(400, `Key ${k} is not allowed (keys.pattern / keys.values)`);
  }
  return keys;
}

const patterns = new Map<string, RegExp>();

/** キーの許可: keys.values に含まれるか、keys.pattern に一致するか */
export function isAllowedKey(d: ResolvedDataset, k: string): boolean {
  if (d.keys.values?.includes(k)) return true;
  if (d.keys.pattern === undefined) return false;
  let re = patterns.get(d.keys.pattern);
  if (!re) {
    re = new RegExp(d.keys.pattern);
    patterns.set(d.keys.pattern, re);
  }
  return re.test(k);
}

function parseTime(v: string | undefined, label: 'from' | 'to'): number {
  if (!v || !/^\d{1,16}$/.test(v)) throw new ApiError(400, `Specify ${label} as UNIX time in milliseconds. In Grafana, use \${__${label}}`);
  return Number(v);
}

/** interval は Grafana の $__interval_ms（ミリ秒の整数）か、30s / 5m / 1h / 1d の形式 */
export function parseInterval(v: string): number {
  const ms = /^[1-9]\d{0,12}$/.test(v) ? Number(v) : parseDuration(v);
  if (ms === undefined) throw new ApiError(400, 'interval must be milliseconds ($__interval_ms in Grafana) or 30s / 5m / 1h / 1d');
  return ms;
}

function parseAgg(v: string | undefined, interval: number | undefined): Agg {
  if (v === undefined || v === '') return 'avg';
  if (!(AGGS as readonly string[]).includes(v)) throw new ApiError(400, `agg must be one of ${AGGS.join(' / ')}`);
  if (interval === undefined) throw new ApiError(400, 'agg requires interval');
  return v as Agg;
}

function parseLatest(v: string | undefined): boolean {
  if (v === undefined) return false;
  if (!/^(1|true)$/.test(v)) throw new ApiError(400, 'latest must be 1');
  return true;
}

function parseFormat(v: string | undefined): Format {
  if (v === undefined || v === '') return 'long';
  if (!(FORMATS as readonly string[]).includes(v)) throw new ApiError(400, `format must be one of ${FORMATS.join(' / ')}`);
  return v as Format;
}

/** 集計の区切りの既定: 日付で分けたキーならその日付の区切り、なければソートキーのタイムゾーン */
export const defaultTimezone = (d: ResolvedDataset): string => (d.partitionKey.bucket !== 'none' ? d.partitionKey.timezone : d.sortKey.timezone);
