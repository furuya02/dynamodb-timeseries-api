// ---------------------------------------------------------------
// 属性の変換（許可リスト、型、別名、換算、ネスト属性）
// ---------------------------------------------------------------
import type { ResolvedDataset } from '../../lib/config';
import { ApiError } from './errors';
import type { Column, Field } from './types';

/** 列名。alias がなければ属性名の . を _ に置き換える（lib/config.ts の重複チェックも同じ規則） */
export const columnName = (f: Field): string => f.alias ?? f.name.replaceAll('.', '_');

/** fields=a,b で返す列を選ぶ。列名と属性名のどちらでも指定できる。未指定なら全列 */
export function selectColumns(d: ResolvedDataset, param: string | undefined): Column[] {
  const all = d.fields.map((field) => ({ column: columnName(field), path: field.name.split('.'), field }));
  const wanted = [
    ...new Set(
      (param ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (wanted.length === 0) return all;
  return wanted.map((w) => {
    const c = all.find((x) => x.column === w || x.field.name === w);
    if (!c) throw new ApiError(400, `fields の ${w} はデータセットに定義されていません。使える列: ${all.map((x) => x.column).join(', ')}`);
    return c;
  });
}

/**
 * 定義した属性だけを読む ProjectionExpression。
 * 予約語（date、count など）を避けるため名前はすべてプレースホルダにする。
 * meta と meta.fw のように重なるパスや同じパスを並べると ValidationException になるため、短い方だけを読む
 */
export function projection(sortKey: string, columns: Column[]): { expression: string; names: Record<string, string> } {
  const names: Record<string, string> = { '#sk': sortKey };
  const minimal: string[][] = [];
  // 安定ソートなので、長さ 1 のソートキーは先頭のまま残る
  for (const p of [[sortKey], ...columns.map((c) => c.path)].sort((a, b) => a.length - b.length)) {
    if (!minimal.some((m) => m.every((part, j) => part === p[j]))) minimal.push(p);
  }
  const paths = minimal.slice(1).map((path, i) =>
    path
      .map((part, j) => {
        names[`#f${i}_${j}`] = part;
        return `#f${i}_${j}`;
      })
      .join('.'),
  );
  return { expression: ['#sk', ...paths].join(', '), names };
}

/** a.b.c のパスで値を取り出す */
export function getPath(item: Record<string, unknown>, path: string[]): unknown {
  let v: unknown = item;
  for (const part of path) v = v !== null && typeof v === 'object' && !(v instanceof Set) ? (v as Record<string, unknown>)[part] : undefined;
  return v;
}

/** 1 アイテムを { 列名: 値 } に変換する。欠損と変換できない値は null */
export function toValues(item: Record<string, unknown>, columns: Column[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c.column] = convert(getPath(item, c.path), c.field);
  return out;
}

const TRUE = /^(true|1)$/i;
const FALSE = /^(false|0)$/i;

/** 値を field.type に揃える */
export function convert(v: unknown, f: Field): unknown {
  if (v === undefined || v === null) return null;
  switch (f.type) {
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
      if (!Number.isFinite(n)) return null;
      // 0.1 倍などで出る 0.30000000000000004 のような誤差を丸める
      return f.scale === undefined ? n : round(n * f.scale);
    }
    case 'string':
      return typeof v === 'string' ? v : typeof v === 'object' ? toJson(v) : String(v);
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string' && TRUE.test(v)) return true;
      if (typeof v === 'string' && FALSE.test(v)) return false;
      return null;
    case 'json':
      return toJson(v);
  }
}

/** 有効数字 12 桁に丸める */
export const round = (n: number): number => Number(n.toPrecision(12));

/** Map / List / Set / Binary を JSON 文字列にする（lib-dynamodb は SS / NS を Set、B を Uint8Array で返す） */
export const toJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x instanceof Uint8Array ? Buffer.from(x).toString('base64') : x));
