import { describe, expect, it } from 'vitest';
import { bucketStart, buckets, isTimezone, offsetMs, parseDuration, parseIso, toLocalIso } from '../../lambda/api/time';

const T0 = Date.parse('2025-11-03T00:00:00Z');
const H = 3_600_000;

describe('offsetMs / isTimezone', () => {
  it.each([
    ['UTC', 0],
    ['+09:00', 9 * H],
    ['-05:30', -5.5 * H],
    ['Asia/Tokyo', 9 * H],
  ])('%s', (tz, expected) => {
    expect(offsetMs(tz, T0)).toBe(expected);
  });

  it('IANA 名は夏時間を反映する（America/New_York は 7 月が -4 時間、11 月 3 日が -5 時間）', () => {
    expect(offsetMs('America/New_York', Date.parse('2025-07-01T12:00:00Z'))).toBe(-4 * H);
    expect(offsetMs('America/New_York', T0)).toBe(-5 * H);
  });

  it('ミリ秒を含む時刻でもずれない', () => {
    expect(offsetMs('Asia/Tokyo', T0 + 123)).toBe(9 * H);
  });

  it('不正なタイムゾーンは false', () => {
    expect(isTimezone('Asia/Tokyo')).toBe(true);
    expect(isTimezone('Mars/Base')).toBe(false);
  });
});

describe('toLocalIso / parseIso', () => {
  it('UTC ミリ秒を tz の壁時計にする', () => {
    expect(toLocalIso(T0, 'UTC')).toBe('2025-11-03T00:00:00');
    expect(toLocalIso(T0, 'Asia/Tokyo')).toBe('2025-11-03T09:00:00');
    expect(toLocalIso(T0, '-05:30')).toBe('2025-11-02T18:30:00');
  });

  it.each([
    ['2025-11-03T09:00:00', 'Asia/Tokyo'],
    ['2025-11-03T09:00:00+09:00', 'UTC'],
    ['2025-11-03T00:00:00.000Z', 'UTC'],
    ['2025-11-03T00:00:00Z', 'Asia/Tokyo'],
    ['2025-11-03', 'UTC'],
  ])('%s（tz=%s）は 2025-11-03T00:00:00Z', (s, tz) => {
    expect(parseIso(s, tz)).toBe(T0);
  });

  it('夏時間の境目（存在しない時刻）を 1 回だけ補正する', () => {
    expect(new Date(parseIso('2025-03-09T03:30:00', 'America/New_York')).toISOString()).toBe('2025-03-09T07:30:00.000Z');
  });

  it('読めない値は NaN', () => {
    expect(parseIso('not a date', 'UTC')).toBeNaN();
  });
});

describe('buckets', () => {
  it('daily は期間内の日付を列挙する', () => {
    expect(buckets(T0, T0 + 2 * 86_400_000, 'daily', 'UTC')).toEqual(['2025-11-03', '2025-11-04', '2025-11-05']);
  });

  it('tz の暦で数える（UTC の前日 23 時は JST では当日）', () => {
    expect(buckets(T0 - H, T0, 'daily', 'Asia/Tokyo')).toEqual(['2025-11-03']);
    expect(buckets(T0 - H, T0, 'daily', 'UTC')).toEqual(['2025-11-02', '2025-11-03']);
  });

  it('monthly は年をまたいでも列挙する', () => {
    expect(buckets(Date.parse('2025-10-15T00:00:00Z'), Date.parse('2026-01-02T00:00:00Z'), 'monthly', 'UTC')).toEqual([
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
    ]);
  });
});

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['5m', 300_000],
    ['12h', 12 * H],
    ['31d', 31 * 24 * H],
  ])('%s', (s, ms) => {
    expect(parseDuration(s)).toBe(ms);
  });

  it.each(['0m', '1w', '5', 'm', '-1h', '1.5h'])('%s は undefined', (s) => {
    expect(parseDuration(s)).toBeUndefined();
  });
});

describe('bucketStart', () => {
  it('UTC では interval の倍数に切り捨てる', () => {
    expect(bucketStart(T0 + 7 * 60_000, 5 * 60_000, 'UTC')).toBe(T0 + 5 * 60_000);
  });

  it('1d は tz の 0 時から始まる（JST の 0 時 = UTC の前日 15 時）', () => {
    expect(bucketStart(T0, 86_400_000, 'Asia/Tokyo')).toBe(T0 - 9 * H);
    expect(bucketStart(T0 - 10 * H, 86_400_000, 'Asia/Tokyo')).toBe(T0 - 33 * H);
  });
});
