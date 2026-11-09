// ---------------------------------------------------------------
// 時刻の計算（外部ライブラリなし）
// タイムゾーンは "UTC" / "+09:00" のようなオフセット / IANA 名（Asia/Tokyo）を受け付ける
// ---------------------------------------------------------------

const OFFSET = /^([+-])(\d{2}):(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (tz: string): Intl.DateTimeFormat => {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
};

/** utcMs の時点で、tz の壁時計が UTC から何ミリ秒ずれているか。不正な tz は RangeError */
export function offsetMs(tz: string, utcMs: number): number {
  if (tz === 'UTC') return 0;
  const m = OFFSET.exec(tz);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
  const p = Object.fromEntries(
    formatterFor(tz)
      .formatToParts(new Date(utcMs))
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(utcMs / 1000) * 1000;
}

export function isTimezone(tz: string): boolean {
  try {
    offsetMs(tz, 0);
    return true;
  } catch {
    return false;
  }
}

/** UTC ミリ秒 → tz の壁時計 "yyyy-MM-ddTHH:mm:ss" */
export function toLocalIso(utcMs: number, tz: string): string {
  return new Date(utcMs + offsetMs(tz, utcMs)).toISOString().slice(0, 19);
}

/** tz の壁時計 "yyyy-MM-ddTHH:mm:ss(.sss)" → UTC ミリ秒 */
function fromLocalIso(local: string, tz: string): number {
  const asUtc = Date.parse(`${local}Z`);
  const guess = asUtc - offsetMs(tz, asUtc);
  return asUtc - offsetMs(tz, guess); // 夏時間の境目のずれを 1 回だけ補正する
}

const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

/** ISO 8601 文字列 → UTC ミリ秒。オフセットのない値は tz の時刻として読む。読めない値は NaN */
export function parseIso(s: string, tz: string): number {
  if (HAS_ZONE.test(s)) return Date.parse(s);
  return fromLocalIso(s.length === 10 ? `${s}T00:00:00` : s, tz);
}

/** from〜to に含まれる日付（daily: yyyy-MM-dd / monthly: yyyy-MM）を tz の暦で列挙する */
export function buckets(from: number, to: number, unit: 'daily' | 'monthly', tz: string): string[] {
  const len = unit === 'daily' ? 10 : 7;
  const out: string[] = [];
  const last = toLocalIso(to, tz).slice(0, len);
  let day = toLocalIso(from, tz).slice(0, 10);
  for (;;) {
    const b = day.slice(0, len);
    if (out[out.length - 1] !== b) out.push(b);
    if (b >= last) break;
    // 暦の上で 1 日進める（タイムゾーンに関係なく日付だけを扱う）
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return out;
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s" / "5m" / "12h" / "31d" → ミリ秒。形式が違えば undefined */
export function parseDuration(s: string): number | undefined {
  const m = /^([1-9]\d{0,12})(s|m|h|d)$/.exec(s);
  return m ? Number(m[1]) * UNIT_MS[m[2]] : undefined;
}

/** 集計の区切りの開始時刻。tz の壁時計で区切るので、1d は tz の 0 時から始まる */
export function bucketStart(t: number, interval: number, tz: string): number {
  const off = offsetMs(tz, t);
  return Math.floor((t + off) / interval) * interval - off;
}
