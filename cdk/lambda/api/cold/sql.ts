// ---------------------------------------------------------------
// コールドストアの SQL
// テーブル（Glue）: パーティションは dataset / dt（UTC の日付）、1 行 = キー × 列 × 1 分の集計
// ---------------------------------------------------------------

/** コールドストアのテーブルの列（取り込み側もこの名前で書く） */
export const COLD_COLUMNS = [
  ['key', 'string'],
  ['field', 'string'], // datasets.yaml の fields[].name
  ['ts', 'bigint'], // 1 分の区切りの開始（UNIX ミリ秒）
  ['cnt', 'bigint'], // 欠損を除いた件数
  ['val_sum', 'double'], // 以下 4 つは数値の列のみ
  ['val_min', 'double'],
  ['val_max', 'double'],
  ['val_last', 'double'],
  ['text_last', 'string'], // 数値以外の列の最後の値
  ['last_ts', 'bigint'], // 最後の値の時刻（UNIX ミリ秒）
] as const;

export const COLD_PARTITIONS = [
  ['dataset', 'string'],
  ['dt', 'string'], // yyyy-MM-dd（UTC）
] as const;

/** S3 のデータの場所（data/dataset=名前/dt=yyyy-MM-dd/*.parquet） */
export const COLD_DATA_PREFIX = 'data/';

/** 1 分（コールドストアの集計の細かさ） */
export const COLD_STEP_MS = 60_000;

export interface ColdTable {
  database: string;
  table: string;
}

export interface ColdSql {
  sql: string;
  params: string[];
}

const IDENT = /^[a-z0-9_]{1,255}$/;

const ident = (s: string): string => {
  if (!IDENT.test(s)) throw new Error(`Not a valid Athena name: ${s}`);
  return `"${s}"`;
};

/** 文字列リテラル（' を重ねてエスケープする）。ExecutionParameters の値にも使う */
export const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface Filter {
  dataset: string;
  keys: string[];
  fields: string[];
  from: number;
  to: number;
}

/**
 * パーティション（dataset、dt）で読む範囲を絞る条件。
 * dataset はパーティション射影（injected）のため値を SQL に直接書く（データセット名は設定で英小文字・数字・_ に限っている）。
 * キーと列名は利用者の入力なので ExecutionParameters で渡す
 */
function where(f: Filter): ColdSql {
  const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
  return {
    sql: [
      `dataset = ${literal(f.dataset)}`,
      `dt BETWEEN '${utcDate(f.from)}' AND '${utcDate(f.to)}'`,
      `key IN (${marks(f.keys.length)})`,
      `field IN (${marks(f.fields.length)})`,
      `ts BETWEEN ${Math.trunc(f.from)} AND ${Math.trunc(f.to)}`,
    ].join(' AND '),
    params: [...f.keys, ...f.fields].map(literal),
  };
}

/**
 * 区切り（interval）ごとに集計し直す。1 分の集計を足し合わせるので、平均は sum / count で正しく求まる。
 * 区切りはタイムゾーンのオフセット（offset、ミリ秒）だけずらす（夏時間の切り替えは考慮しない）
 */
export function rangeQuery(t: ColdTable, f: Filter & { interval: number; offset: number; limit: number }): ColdSql {
  const w = where(f);
  const iv = Math.trunc(f.interval);
  const off = Math.trunc(f.offset);
  return {
    sql: [
      `SELECT key, field, (ts + ${off}) / ${iv} * ${iv} - ${off} AS t,`,
      '  sum(cnt) AS cnt, sum(val_sum) AS val_sum, min(val_min) AS val_min, max(val_max) AS val_max,',
      '  max_by(val_last, last_ts) AS val_last, max_by(text_last, last_ts) AS text_last, max(last_ts) AS last_ts',
      `FROM ${ident(t.database)}.${ident(t.table)}`,
      `WHERE ${w.sql}`,
      'GROUP BY 1, 2, 3',
      'ORDER BY 3, 1, 2',
      `LIMIT ${Math.trunc(f.limit)}`,
    ].join('\n'),
    params: w.params,
  };
}

/** キー × 列ごとの最後の値 */
export function latestQuery(t: ColdTable, f: Filter): ColdSql {
  const w = where(f);
  return {
    sql: [
      'SELECT key, field, max_by(val_last, last_ts) AS val_last, max_by(text_last, last_ts) AS text_last, max(last_ts) AS last_ts',
      `FROM ${ident(t.database)}.${ident(t.table)}`,
      `WHERE ${w.sql}`,
      'GROUP BY 1, 2',
    ].join('\n'),
    params: w.params,
  };
}
