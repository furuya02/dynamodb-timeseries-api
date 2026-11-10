import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lambda/api/errors';
import { defaultTimezone, isAllowedKey, parseInterval, parseQueryRequest, type QueryParams } from '../../lambda/api/request';
import { loadConfig } from '../../lib/config';
import { base } from './helpers';

// 結合テストと同じ設定ファイルを使う（DynamoDB には接続しない）
const datasets = loadConfig(path.join(__dirname, '../integration/datasets.yaml'));
const H = 3_600_000;
const T0 = Date.parse('2025-11-03T00:00:00Z');

const errorOf = (p: QueryParams): string => {
  try {
    parseQueryRequest(datasets, p);
    return 'no error';
  } catch (e) {
    return e instanceof ApiError ? `${e.status} ${e.message}` : String(e);
  }
};

describe('parseQueryRequest: 入力の検証', () => {
  it.each<[QueryParams, string]>([
    [{}, '400 Specify dataset'],
    [{ dataset: 'nope', key: 'x', from: '0', to: '1' }, '404 Dataset nope'],
    [{ dataset: 'epoch_ms', from: '0', to: '1' }, '400 Specify key'],
    [{ dataset: 'epoch_ms', key: ' , ', from: '0', to: '1' }, '400 Specify key'],
    [{ dataset: 'epoch_ms', key: 'room-1', from: '0', to: '1' }, '400 Key room-1 is not allowed'],
    [{ dataset: 'epoch_ms', key: 'room-01,room-02,room-03,room-04', from: '0', to: '1' }, '400 Up to 3 keys'],
    [{ dataset: 'iso_prefix', key: 'c', from: '0', to: '1' }, '400 Key c is not allowed'],
    [{ dataset: 'epoch_ms', key: 'room-01', from: 'now-1h', to: '1' }, '400 Specify from as UNIX time'],
    [{ dataset: 'epoch_ms', key: 'room-01', from: '0' }, '400 Specify to as UNIX time'],
    [{ dataset: 'epoch_ms', key: 'room-01', from: '2', to: '1' }, '400 from must be earlier'],
    [{ dataset: 'epoch_ms', key: 'room-01', from: '0', to: `${32 * 24 * H}` }, '400 The time range is too long. Keep it within 31d'],
    [{ dataset: 'transform', key: 'x', from: '0', to: '1', fields: 'secret' }, '400 secret in fields'],
    [{ dataset: 'agg', key: 'a', from: '0', to: '1', agg: 'avg' }, '400 agg requires interval'],
    [{ dataset: 'agg', key: 'a', from: '0', to: '1', interval: '1m', agg: 'median' }, '400 agg must be one of avg / min'],
    [{ dataset: 'agg', key: 'a', from: '0', to: '1', interval: '1w' }, '400 interval must be'],
    [{ dataset: 'agg', key: 'a', from: '0', to: '1', interval: '0' }, '400 interval must be'],
    [{ dataset: 'agg', key: 'a', from: '0', to: '1', interval: '1m', latest: '1' }, '400 latest and interval cannot'],
    [{ dataset: 'agg', key: 'a', from: '0', to: '1', latest: 'yes' }, '400 latest must be 1'],
    [{ dataset: 'agg', key: 'a', from: '0', to: '1', format: 'table' }, '400 format must be one of long / wide'],
    [{ dataset: 'agg', key: 'a', from: '0', to: '1', tz: 'Mars/Base' }, '400 tz must be'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Grafana の変数が置き換わらずに届く場合のテスト（文字列のまま送る）
    [{ dataset: 'agg', key: '${key:csv}', from: '0', to: '1' }, '400 key=${key:csv}: a Grafana variable was not replaced'],
    [{ dataset: 'agg', key: 'a', from: '0', to: '1', interval: '$__interval_ms' }, '400 interval=$__interval_ms: a Grafana variable'],
  ])('%j → %s', (p, expected) => {
    expect(errorOf(p)).toMatch(new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('期間は maxRange ちょうどまで受け付ける', () => {
    expect(errorOf({ dataset: 'epoch_ms', key: 'room-01', from: '0', to: `${31 * 24 * H}` })).toBe('no error');
  });
});

describe('parseQueryRequest: 既定値と変換', () => {
  it('既定値: agg=avg、format=long、latest=false、全列', () => {
    const r = parseQueryRequest(datasets, { dataset: 'agg', key: 'b, a,b', from: `${T0}`, to: `${T0 + H}` });
    expect(r).toMatchObject({ name: 'agg', keys: ['b', 'a'], from: T0, to: T0 + H, agg: 'avg', format: 'long', latest: false, interval: undefined });
    expect(r.columns.map((c) => c.column)).toEqual(['value', 'label']);
  });

  it('集計時は from / to を区切りに合わせて丸める', () => {
    const r = parseQueryRequest(datasets, { dataset: 'agg', key: 'a', from: `${T0 + 7 * 60_000}`, to: `${T0 + 58 * 60_000}`, interval: '15m' });
    expect([r.from, r.to]).toEqual([T0, T0 + H - 1]);
  });

  it('集計の区切りの既定は、日付で分けたキーのタイムゾーン', () => {
    const r = parseQueryRequest(datasets, { dataset: 'daily_jst', key: 'm1', from: `${T0}`, to: `${T0 + H}`, interval: '1d' });
    expect(r.tz).toBe('Asia/Tokyo');
  });

  it('latest は 1 と true を受け付ける', () => {
    expect(parseQueryRequest(datasets, { dataset: 'agg', key: 'a', from: '0', to: '1', latest: 'true' }).latest).toBe(true);
  });
});

describe('isAllowedKey / parseInterval / defaultTimezone', () => {
  it('values に含まれるか pattern に一致すれば許可', () => {
    const d = base({ keys: { values: ['x'], pattern: '^room-[0-9]{2}$' } });
    expect(['x', 'room-01', 'room-1', 'y'].map((k) => isAllowedKey(d, k))).toEqual([true, true, false, false]);
  });

  it('interval はミリ秒の整数か 30s / 5m / 1h / 1d', () => {
    expect(parseInterval('60000')).toBe(60_000);
    expect(parseInterval('5m')).toBe(300_000);
    expect(() => parseInterval('5.5')).toThrow(ApiError);
  });

  it('日付で分けていなければソートキーのタイムゾーン', () => {
    expect(defaultTimezone(base({ sortKey: { name: 'ts', format: 'iso8601', timezone: '+09:00' } }))).toBe('+09:00');
  });
});
