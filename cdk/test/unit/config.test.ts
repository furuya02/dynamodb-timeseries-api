import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinLimits, ConfigError, loadConfig } from '../../lib/config';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsapi-config-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function write(yaml: string): string {
  const file = path.join(dir, `c${n++}.yaml`);
  fs.writeFileSync(file, yaml);
  return file;
}
const errorOf = (yaml: string): string => {
  try {
    loadConfig(write(yaml));
    return 'no error';
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.message;
  }
};

const ok = `
datasets:
  room_temp:
    table: iot-metrics
    partitionKey: { name: deviceId }
    sortKey: { name: ts, format: epoch_ms }
    keys: { pattern: "^room-[0-9]{2}$" }
    fields: [ { name: temperature } ]
`;

describe('loadConfig: 正しい設定', () => {
  it('既定値を反映する（limits は組み込み → defaults → データセットの順に上書き）', () => {
    const ds = loadConfig(
      write(`${ok}    limits: { maxItems: 10 }
  other:
    table: tbl2
    partitionKey: { name: pk }
    sortKey: { name: sk, format: iso8601 }
    keys: { values: [a] }
    fields: [ { name: v } ]
defaults:
  limits: { maxKeys: 5 }
  cacheTtlSeconds: 60
`),
    );
    expect(ds.room_temp.limits).toEqual({ ...builtinLimits, maxKeys: 5, maxItems: 10 });
    expect(ds.room_temp.cacheTtlSeconds).toBe(60);
    expect(ds.room_temp.partitionKey).toEqual({ name: 'deviceId', template: '{key}', bucket: 'none', timezone: 'UTC' });
    expect(ds.room_temp.sortKey).toEqual({ name: 'ts', format: 'epoch_ms', prefix: '', timezone: 'UTC' });
    expect(ds.room_temp.fields[0]).toEqual({ name: 'temperature', type: 'number' });
    expect(ds.other.limits.maxItems).toBe(builtinLimits.maxItems);
  });

  it('リポジトリのサンプル設定（config/datasets.yaml）が通る', () => {
    expect(Object.keys(loadConfig(path.join(__dirname, '../../../config/datasets.yaml')))).toEqual(['room_temp']);
  });
});

describe('loadConfig: 誤り', () => {
  it('ファイルがない / YAML として読めない', () => {
    expect(() => loadConfig(path.join(dir, 'none.yaml'))).toThrow('設定ファイルが見つかりません');
    expect(errorOf('datasets: [')).toContain('YAML として読み込めません');
  });

  it('datasets が空', () => {
    expect(errorOf('datasets: {}')).toContain('datasets を 1 つ以上定義してください');
  });

  it('型の誤りは、どのデータセットのどの項目かを一覧で示し、組み合わせの誤りが後で出ることを注記する', () => {
    const msg = errorOf(`
datasets:
  Bad-Name:
    table: x
    partitionKey: { name: pk }
    sortKey: { name: ts, format: epoch_us }
    keys: { values: [a] }
    fields: [ { name: v, type: string, scale: 2 } ]
    limits: { maxRange: 1y }
    unknown: 1
`);
    expect(msg).toContain('datasets.Bad-Name: データセット名は英小文字で始まり');
    expect(msg).toContain('datasets.Bad-Name.table: DynamoDB のテーブル名として不正です');
    expect(msg).toContain('datasets.Bad-Name.sortKey.format');
    expect(msg).toContain('datasets.Bad-Name.limits.maxRange: 90m / 12h / 31d の形式で指定してください');
    expect(msg).toContain('（型の誤りを直すと、項目の組み合わせに関する誤りが追加で表示されることがあります）');
  });

  it.each([
    ['{key} がない template', 'partitionKey: { name: pk, template: "room" }', 'partitionKey.template: {key} を含めてください'],
    [
      'bucket と日付トークンの不一致',
      'partitionKey: { name: pk, template: "{key}#{yyyy-MM}", bucket: daily }',
      'bucket: daily のときは {yyyy-MM-dd} を含めてください',
    ],
    ['日付トークンがあるのに bucket がない', 'partitionKey: { name: pk, template: "{key}#{yyyy-MM-dd}" }', 'bucket: daily または monthly を指定してください'],
    ['bucket なしで partitionKey.timezone', 'partitionKey: { name: pk, timezone: Asia/Tokyo }', 'timezone は bucket: daily / monthly のときだけ'],
  ])('組み合わせの誤り: %s', (_label, pk, expected) => {
    const msg = errorOf(`
datasets:
  ds:
    table: tbl
    ${pk}
    sortKey: { name: ts, format: epoch_ms }
    keys: { values: [a] }
    fields: [ { name: v } ]
`);
    expect(msg).toContain(expected);
    expect(msg).not.toContain('型の誤りを直すと');
  });

  it.each([
    ['keys に pattern も values もない', 'keys: {}', 'pattern か values のどちらかを指定してください'],
    ['不正な正規表現', 'keys: { pattern: "([" }', 'keys.pattern: 正規表現として不正です'],
  ])('組み合わせの誤り: %s', (_label, keys, expected) => {
    if (!expected) return;
    const msg = errorOf(`
datasets:
  ds:
    table: tbl
    partitionKey: { name: pk }
    sortKey: { name: ts, format: epoch_ms }
    ${keys}
    fields: [ { name: v } ]
`);
    expect(msg).toContain(expected);
  });

  it('epoch のソートキーに timezone、ソートキーを fields に書く、列名の重複（meta.fw と alias: meta_fw）', () => {
    const msg = errorOf(`
datasets:
  ds:
    table: tbl
    partitionKey: { name: pk }
    sortKey: { name: ts, format: epoch_ms, timezone: Asia/Tokyo }
    keys: { values: [a] }
    fields: [ { name: ts }, { name: meta.fw, type: string }, { name: fw, alias: meta_fw, type: string } ]
`);
    expect(msg).toContain('timezone は format: iso8601 のときだけ');
    expect(msg).toContain('ソートキーは時刻列として自動で返すため');
    expect(msg).toContain('列名 meta_fw が重複しています');
  });
});

describe('loadConfig: cold', () => {
  it('cold: {} は既定値（athena、hotRetention 7d、maxRange 400d）', () => {
    const d = loadConfig(write(`${ok}    cold: {}\n`)).room_temp;
    expect(d.cold).toEqual({ type: 'athena', hotRetention: '7d', maxRange: '400d' });
  });

  it('期間の形式と未知の項目', () => {
    expect(errorOf(`${ok}    cold: { hotRetention: 7 }\n`)).toContain('cold.hotRetention');
    expect(errorOf(`${ok}    cold: { hotRetention: 1w }\n`)).toContain('90m / 12h / 7d');
    expect(errorOf(`${ok}    cold: { maxScanGb: 1 }\n`)).toContain('cold');
  });
});
