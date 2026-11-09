// ---------------------------------------------------------------
// キー条件: 問い合わせるパーティションキーの値と、ソートキーの範囲
// ---------------------------------------------------------------
import type { ResolvedDataset } from '../../lib/config';
import { buckets, parseIso, toLocalIso } from './time';

/** ISO 8601 の範囲の上限に付ける文字。保存値の末尾（.000Z や +09:00）の違いを吸収する */
const MAX_CHAR = '￿';

const DATE_TOKEN = { daily: '{yyyy-MM-dd}', monthly: '{yyyy-MM}' } as const;

/** 問い合わせるパーティションキーの値（日付で分けたキーなら、期間内の日付ごと） */
export function partitionValues(d: ResolvedDataset, key: string, from: number, to: number): string[] {
  const pk = d.partitionKey;
  const base = pk.template.replaceAll('{key}', key);
  if (pk.bucket === 'none') return [base];
  const token = DATE_TOKEN[pk.bucket];
  return buckets(from, to, pk.bucket, pk.timezone).map((b) => base.replaceAll(token, b));
}

/**
 * ソートキーの範囲（BETWEEN の下限・上限）。
 * epoch 秒への切り捨てや ISO 8601 の末尾の違いがあるため少し広めに取り、正確な絞り込みは readTime の後で行う
 */
export function sortRange(d: ResolvedDataset, from: number, to: number): [string | number, string | number] {
  const { format, prefix, timezone } = d.sortKey;
  if (format === 'iso8601') return [prefix + toLocalIso(from, timezone), prefix + toLocalIso(to, timezone) + MAX_CHAR];
  const [lo, hi] = format === 'epoch_s' ? [Math.floor(from / 1000), Math.floor(to / 1000)] : [from, to];
  return prefix ? [prefix + lo, prefix + hi] : [lo, hi];
}

/** ソートキーの値 → UNIX ミリ秒。読めない値は NaN */
export function readTime(d: ResolvedDataset, v: unknown): number {
  const { format, prefix, timezone } = d.sortKey;
  const s = typeof v === 'string' && prefix && v.startsWith(prefix) ? v.slice(prefix.length) : v;
  if (format === 'iso8601') return parseIso(String(s), timezone);
  const n = Number(s);
  return format === 'epoch_s' ? n * 1000 : n;
}
