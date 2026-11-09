// ---------------------------------------------------------------
// API 全体で共有する型と定数
// ---------------------------------------------------------------
import type { ResolvedDataset } from '../../lib/config';

export type Datasets = Record<string, ResolvedDataset>;
export type Field = ResolvedDataset['fields'][number];

/** 集計方法（agg パラメータ） */
export const AGGS = ['avg', 'min', 'max', 'sum', 'count', 'last'] as const;
export type Agg = (typeof AGGS)[number];

/** 出力形式（format パラメータ）。long: 行 = 時刻 × キー / wide: 列 = キー_列名 */
export const FORMATS = ['long', 'wide'] as const;
export type Format = (typeof FORMATS)[number];

/** 応答に含める 1 列（属性の取り出し方と変換方法） */
export interface Column {
  /** 応答の列名 */
  column: string;
  /** 属性のパス（meta.fw → ['meta', 'fw']） */
  path: string[];
  field: Field;
}

/** 検証済みの /query のリクエスト */
export interface QueryRequest {
  name: string;
  dataset: ResolvedDataset;
  keys: string[];
  /** 問い合わせる範囲（UNIX ミリ秒、両端を含む）。集計時は区切りに合わせて丸めた値 */
  from: number;
  to: number;
  columns: Column[];
  /** ダウンサンプリングの区切り（ミリ秒） */
  interval?: number;
  agg: Agg;
  latest: boolean;
  format: Format;
  /** 集計の区切りの基準になるタイムゾーン */
  tz: string;
}

/** 1 アイテム分の行 */
export interface Row {
  time: number;
  key: string;
  values: Record<string, unknown>;
}

export type TruncatedBy = 'maxItems' | 'maxPages' | 'maxRcu';

export interface ReadMeta {
  /** 実行した Query の数（キー × 日付） */
  queries: number;
  pages: number;
  /** DynamoDB から読んだ件数（範囲外で除いたものを含む） */
  items: number;
  truncated: boolean;
  truncatedBy?: TruncatedBy;
  consumedRcu: number;
}

export interface ReadResult {
  rows: Row[];
  meta: ReadMeta;
}

/** API の処理結果（Lambda の応答や HTTP サーバーの応答に変換する） */
export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** 構造化ログの 1 行 */
export type LogLine = Record<string, unknown>;
export type Logger = (line: LogLine) => void;
