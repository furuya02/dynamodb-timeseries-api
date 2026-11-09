// ---------------------------------------------------------------
// サンプルデータ（疑似センサー）の生成
// 実際のセンサーデータに近づけるため、次の変化を重ねる。どれも時刻と部屋から決まり、何度生成しても同じ値になる
//   - 1 日周期の変化（14 時ごろ最高）
//   - 日ごとの天気の違い（日をまたいでなめらかに変わる）
//   - 平日の日中は空調で温度・湿度が抑えられる
//   - 部屋ごとの性格（窓際は振れ幅が大きい、内側は小さい）
//   - ときどき起きる一時的な高温（サンプルのアラートが発火する）
//   - 短いデータの欠け（センサーの通信断に見立てる）
// ---------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 日本時間（JST）のオフセット */
const JST = 9 * HOUR;

export interface SeedOptions {
  rooms: number;
  days: number;
  /** 間隔（ミリ秒） */
  stepMs: number;
  /** 最後の時刻（ミリ秒。stepMs の倍数に切り捨てる） */
  end: number;
  seed?: number;
}

/** 部屋ごとの性格。base: 平均の高さ、amplitude: 1 日の振れ幅の倍率 */
export const ROOM_PROFILES = [
  { base: 0, amplitude: 1.0 }, // 標準
  { base: 1.0, amplitude: 1.5 }, // 窓際（日中に暑く、夜に冷える）
  { base: 2.0, amplitude: 0.6 }, // 内側（変化が小さい）
] as const;

export const roomIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `room-${String(i + 1).padStart(2, '0')}`);
const profileOf = (room: number) => ROOM_PROFILES[room % ROOM_PROFILES.length];

/** 再現できる疑似乱数（同じ seed なら同じ値の列になる） */
export function random(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

/** 整数の組から [0, 1) の値を決める（日付や部屋ごとに決まった値を出すため） */
export function hash(...xs: number[]): number {
  let h = 2166136261;
  for (const x of xs) {
    h ^= x | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
  }
  h ^= h >>> 15;
  return (h >>> 0) / 2 ** 32;
}

/** JST の日付の通し番号（1970-01-01 が 0） */
export const jstDay = (t: number): number => Math.floor((t + JST) / DAY);
/** JST の時刻（0〜24 時、小数あり） */
export const jstHour = (t: number): number => ((((t + JST) % DAY) + DAY) % DAY) / HOUR;

/** 日ごとの天気（℃ のずれ）。数日周期のうねりと日ごとのばらつきを、日をまたいでなめらかにつなぐ */
export function weather(t: number): number {
  const at = (day: number) => 2 * Math.sin((day * 2 * Math.PI) / 5.3) + 3 * (hash(day, 7) - 0.5);
  const x = (t + JST) / DAY - 0.5; // 各日の正午をその日の値にする
  const d = Math.floor(x);
  const f = x - d;
  const w = (1 - Math.cos(f * Math.PI)) / 2; // なめらかに補間する
  return at(d) * (1 - w) + at(d + 1) * w;
}

/** 平日（月〜金）の 9〜18 時（JST）か。この時間は空調が入る */
export function isOfficeHours(t: number): boolean {
  const weekday = (jstDay(t) + 4) % 7; // 1970-01-01 は木曜日（0 = 日曜日）
  const hour = jstHour(t);
  return weekday >= 1 && weekday <= 5 && hour >= 9 && hour < 18;
}

/** 一時的な高温（その部屋・その日に、決まった時刻から 40 分間 +5℃）。約 3 日に 1 回 */
export function spike(room: number, t: number): number {
  const day = jstDay(t);
  if (hash(day, room, 11) >= 0.35) return 0;
  const startHour = 10 + hash(day, room, 12) * 6; // 10〜16 時
  const hour = jstHour(t);
  return hour >= startHour && hour < startHour + 40 / 60 ? 5 : 0;
}

/** データの欠け（その部屋・その日に、決まった時刻から 30〜90 分）。約 4 日に 1 回 */
export function inGap(room: number, t: number): boolean {
  const day = jstDay(t);
  if (hash(day, room, 21) >= 0.25) return false;
  const startHour = hash(day, room, 22) * 22;
  const length = 0.5 + hash(day, room, 23);
  const hour = jstHour(t);
  return hour >= startHour && hour < startHour + length;
}

/** 空調で目標値へ寄せる（factor: 0 ならそのまま、1 なら目標値） */
const towards = (value: number, target: number, factor: number) => value + (target - value) * factor;

/** ある部屋・ある時刻の温度と湿度。小数第 1 位まで */
export function reading(room: number, t: number, rand: () => number): { temperature: number; humidity: number } {
  const p = profileOf(room);
  const daily = Math.cos(((jstHour(t) - 14) / 24) * 2 * Math.PI); // 14 時に 1、2 時に -1
  const w = weather(t);
  let temperature = 22 + p.base + 3 * p.amplitude * daily + w + spike(room, t);
  let humidity = 55 - p.base * 3 - 8 * p.amplitude * daily - 1.5 * w;
  if (isOfficeHours(t)) {
    temperature = towards(temperature, 24.5 + p.base * 0.3, 0.6);
    humidity = towards(humidity, 50, 0.5);
  }
  temperature += (rand() - 0.5) * 0.6;
  humidity = Math.min(95, Math.max(15, humidity + (rand() - 0.5) * 2));
  return { temperature: Math.round(temperature * 10) / 10, humidity: Math.round(humidity * 10) / 10 };
}

/**
 * サンプルテーブル（deviceId + ts）のアイテム。
 * 部屋ごとの時系列（欠けの時間は書かない）と、キー一覧（GET /keys）用の登録用アイテム（deviceId = devices、datasets.yaml の keys.list に対応）
 */
export function generateItems(o: SeedOptions): { items: Record<string, unknown>[]; start: number; end: number } {
  const end = Math.floor(o.end / o.stepMs) * o.stepMs;
  const start = end - o.days * DAY;
  const rand = random(o.seed);
  const rooms = roomIds(o.rooms);
  const items: Record<string, unknown>[] = [];
  for (const [r, deviceId] of rooms.entries()) {
    for (let ts = start; ts <= end; ts += o.stepMs) {
      if (inGap(r, ts)) continue;
      items.push({ deviceId, ts, ...reading(r, ts, rand) });
    }
  }
  for (const [i, id] of rooms.entries()) items.push({ deviceId: 'devices', ts: i, id });
  return { items, start, end };
}
