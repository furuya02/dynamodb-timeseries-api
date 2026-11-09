import { describe, expect, it } from 'vitest';
import { generateItems, hash, inGap, isOfficeHours, jstDay, jstHour, random, reading, roomIds, spike, weather } from '../lib/seed-data.ts';

const M = 60_000;
const H = 60 * M;
/** JST の日時（YYYY-MM-DDTHH:mm）→ UNIX ミリ秒 */
const jst = (s: string) => Date.parse(`${s}:00+09:00`);
const end = jst('2025-11-10T00:00');
const week = generateItems({ rooms: 3, days: 7, stepMs: M, end });
const series = (deviceId: string) => week.items.filter((i) => i.deviceId === deviceId) as { ts: number; temperature: number; humidity: number }[];

describe('generateItems', () => {
  it('部屋 × 1 分おきの時系列（欠けの時間は除く）と、登録用アイテム 3 件', () => {
    const full = 3 * (7 * 1440 + 1);
    const rooms = week.items.filter((i) => i.deviceId !== 'devices');
    expect(rooms.length).toBeLessThan(full);
    expect(rooms.length).toBeGreaterThan(full * 0.97);
    expect(week.items.slice(-3)).toEqual([
      { deviceId: 'devices', ts: 0, id: 'room-01' },
      { deviceId: 'devices', ts: 1, id: 'room-02' },
      { deviceId: 'devices', ts: 2, id: 'room-03' },
    ]);
  });

  it('最後の時刻は間隔の倍数に切り捨てる', () => {
    const r = generateItems({ rooms: 1, days: 1, stepMs: M, end: end + 30_000 });
    expect(r.end).toBe(end);
    expect(r.start).toBe(end - 24 * H);
  });

  it('同じ条件なら同じデータ', () => {
    expect(generateItems({ rooms: 1, days: 1, stepMs: M, end }).items).toEqual(generateItems({ rooms: 1, days: 1, stepMs: M, end }).items);
  });

  it('日ごとの最高気温が日によって変わる（天気の違い）', () => {
    const maxByDay = new Map<number, number>();
    for (const r of series('room-01')) maxByDay.set(jstDay(r.ts), Math.max(maxByDay.get(jstDay(r.ts)) ?? Number.NEGATIVE_INFINITY, r.temperature));
    const values = [...maxByDay.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(1.5);
  });

  it('一時的な高温で 27℃ を超える時間がある（サンプルのアラートが発火する）', () => {
    expect(week.items.some((i) => typeof i.temperature === 'number' && i.temperature > 27)).toBe(true);
  });

  it('データの欠けがある（隣り合う時刻の差が間隔より大きい）', () => {
    const ts = series('room-01').map((r) => r.ts);
    const gaps = ts.slice(1).filter((t, i) => t - ts[i] > M);
    expect(gaps.length).toBeGreaterThan(0);
  });
});

describe('変化の部品', () => {
  it('jstDay / jstHour', () => {
    expect(jstHour(jst('2025-11-03T14:30'))).toBe(14.5);
    expect(jstDay(jst('2025-11-04T00:00')) - jstDay(jst('2025-11-03T23:59'))).toBe(1);
  });

  it('平日の 9〜18 時だけ空調が入る', () => {
    expect(isOfficeHours(jst('2025-11-03T10:00'))).toBe(true); // 月曜
    expect(isOfficeHours(jst('2025-11-03T18:00'))).toBe(false);
    expect(isOfficeHours(jst('2025-11-08T10:00'))).toBe(false); // 土曜
    expect(isOfficeHours(jst('2025-11-09T10:00'))).toBe(false); // 日曜
  });

  it('天気は日をまたいでなめらかに変わる（1 分の差で大きく跳ばない）', () => {
    for (let t = jst('2025-11-03T00:00'); t < jst('2025-11-10T00:00'); t += 10 * M) {
      expect(Math.abs(weather(t + M) - weather(t))).toBeLessThan(0.05);
    }
  });

  it('一時的な高温は +5℃ か 0、欠けは決まった時間帯だけ', () => {
    const values = new Set<number>();
    for (let t = jst('2025-11-03T00:00'); t < jst('2025-11-10T00:00'); t += 5 * M) values.add(spike(0, t));
    expect([...values].sort()).toEqual([0, 5]);
    const t = jst('2025-11-03T12:00');
    expect(inGap(0, t)).toBe(inGap(0, t));
  });

  it('窓際の部屋（room-02）は、日中と夜の差が標準の部屋より大きい', () => {
    const range = (room: number) => {
      const noise = () => 0.5;
      const day = jst('2025-11-08T00:00'); // 土曜（空調なし）
      const temps = Array.from({ length: 24 }, (_, h) => reading(room, day + h * H, noise).temperature - spike(room, day + h * H));
      return Math.max(...temps) - Math.min(...temps);
    };
    expect(range(1)).toBeGreaterThan(range(0));
    expect(range(2)).toBeLessThan(range(0));
  });

  it('値は小数第 1 位まで、湿度は 15〜95% に収める', () => {
    for (const r of series('room-02')) {
      expect(Math.round(r.temperature * 10) / 10).toBe(r.temperature);
      expect(r.humidity).toBeGreaterThanOrEqual(15);
      expect(r.humidity).toBeLessThanOrEqual(95);
    }
  });

  it('hash は [0, 1) の決まった値、random は 0 以上 1 未満、roomIds', () => {
    expect(hash(1, 2)).toBe(hash(1, 2));
    expect(hash(1, 2)).not.toBe(hash(2, 1));
    const r = random(1);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(roomIds(2)).toEqual(['room-01', 'room-02']);
  });
});
