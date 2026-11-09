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
  const name = requireValue(p.dataset, 'dataset を指定してください');
  const dataset = datasets[name];
  if (!dataset) throw new ApiError(404, `データセット ${name} は定義されていません`);

  const keys = parseKeys(dataset, p.key);
  const from = parseTime(p.from, 'from');
  const to = parseTime(p.to, 'to');
  if (from > to) throw new ApiError(400, 'from は to 以前の時刻を指定してください');
  // コールドストアを読むデータセットでは、DynamoDB を読む期間は hotRetention までに収まるため cold.maxRange を使う
  const [rangeText, rangeName] = dataset.cold ? [dataset.cold.maxRange, 'cold.maxRange'] : [dataset.limits.maxRange, 'limits.maxRange'];
  const maxRange = parseDuration(rangeText) ?? Number.POSITIVE_INFINITY;
  if (to - from > maxRange) throw new ApiError(400, `期間が長すぎます。${rangeText} 以内にしてください（${rangeName}）`);

  const interval = p.interval === undefined || p.interval === '' ? undefined : parseInterval(p.interval);
  const agg = parseAgg(p.agg, interval);
  const latest = parseLatest(p.latest);
  if (latest && interval !== undefined) throw new ApiError(400, 'latest と interval は同時に指定できません');
  const format = parseFormat(p.format);
  const tz = p.tz ?? defaultTimezone(dataset);
  if (!isTimezone(tz)) throw new ApiError(400, 'tz は UTC、+09:00 のようなオフセット、または Asia/Tokyo のような IANA 名を指定してください');

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
        `${k}=${v}: Grafana の変数が置き換えられていません。アラートのクエリでは、ダッシュボードの変数と $__interval_ms は使えません（key は値を直接書き、interval は 5m のような固定値か latest=1 を使ってください）`,
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
  if (keys.length === 0) throw new ApiError(400, 'key を指定してください（複数の場合はカンマ区切り）');
  if (keys.length > d.limits.maxKeys) throw new ApiError(400, `key は ${d.limits.maxKeys} 個まで指定できます（limits.maxKeys）`);
  for (const k of keys) {
    if (!isAllowedKey(d, k)) throw new ApiError(400, `key ${k} は許可されていません（keys.pattern / keys.values）`);
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
  if (!v || !/^\d{1,16}$/.test(v)) throw new ApiError(400, `${label} を UNIX 時刻（ミリ秒）で指定してください。Grafana では \${__${label}} を使います`);
  return Number(v);
}

/** interval は Grafana の $__interval_ms（ミリ秒の整数）か、30s / 5m / 1h / 1d の形式 */
export function parseInterval(v: string): number {
  const ms = /^[1-9]\d{0,12}$/.test(v) ? Number(v) : parseDuration(v);
  if (ms === undefined) throw new ApiError(400, 'interval はミリ秒（Grafana では $__interval_ms）か、30s / 5m / 1h / 1d の形式で指定してください');
  return ms;
}

function parseAgg(v: string | undefined, interval: number | undefined): Agg {
  if (v === undefined || v === '') return 'avg';
  if (!(AGGS as readonly string[]).includes(v)) throw new ApiError(400, `agg は ${AGGS.join(' / ')} のいずれかを指定してください`);
  if (interval === undefined) throw new ApiError(400, 'agg は interval と一緒に指定してください');
  return v as Agg;
}

function parseLatest(v: string | undefined): boolean {
  if (v === undefined) return false;
  if (!/^(1|true)$/.test(v)) throw new ApiError(400, 'latest は 1 を指定してください');
  return true;
}

function parseFormat(v: string | undefined): Format {
  if (v === undefined || v === '') return 'long';
  if (!(FORMATS as readonly string[]).includes(v)) throw new ApiError(400, `format は ${FORMATS.join(' / ')} のいずれかを指定してください`);
  return v as Format;
}

/** 集計の区切りの既定: 日付で分けたキーならその日付の区切り、なければソートキーのタイムゾーン */
export const defaultTimezone = (d: ResolvedDataset): string => (d.partitionKey.bucket !== 'none' ? d.partitionKey.timezone : d.sortKey.timezone);
