// ---------------------------------------------------------------
// データセット定義の推定（pnpm init-dataset）
// DescribeTable のキー情報と、Scan で読んだ少量のアイテムから datasets.yaml の下書きを作る
// ---------------------------------------------------------------
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

export type Item = Record<string, AttributeValue>;

export interface InferInput {
  table: string;
  index?: string;
  /** データセット名（省略するとテーブル名から作る） */
  name?: string;
  /** テーブルまたはインデックスのキー */
  partitionKey: string;
  sortKey: string;
  /** テーブル本体のキー（GSI の場合、属性の推定から除く） */
  tableKeys: string[];
  items: Item[];
}

export interface InferResult {
  name: string;
  dataset: Record<string, unknown>;
  /** 利用者に確認してほしい点 */
  notes: string[];
}

const DATE = /\d{4}-\d{2}-\d{2}/;
const MONTH = /\d{4}-\d{2}(?!-\d)/;
const ISO = /^(.*?)(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)(Z|[+-]\d{2}:?\d{2})?$/;
const PREFIXED_EPOCH = /^(.*?)(\d{10}|\d{13})$/;
/** パーティションキーの区切り文字 */
const SEP = /([#:|/])/;
const DATE_PLACEHOLDER = '\u0000';
const GENERIC_KEY_PATTERN = '^[A-Za-z0-9_.:-]{1,64}$';

const scalar = (v: AttributeValue | undefined): string | undefined => v?.S ?? v?.N;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 出現回数が最も多い値と、値ごとの回数 */
export function majority<T>(xs: T[]): [T, Map<T, number>] {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [[...m].sort((a, b) => b[1] - a[1])[0][0], m];
}

export function inferDataset(input: InferInput): InferResult {
  const notes: string[] = [];
  const sortKeyValues = input.items.map((i) => i[input.sortKey]).filter((v): v is AttributeValue => v !== undefined);
  const { sortKey, match } = inferSortKey(input.sortKey, sortKeyValues, notes);

  // ソートキーの形式が合わないアイテム（別の種類）は、キーと属性の推定から除く
  const others = input.items.filter((i) => !match(i[input.sortKey]));
  if (others.length > 0) {
    notes.push(
      `${others.length} items have a different sort key format (e.g. ${input.partitionKey}=${scalar(others[0][input.partitionKey])}, ${input.sortKey}=${scalar(others[0][input.sortKey])}). They were excluded from the inference`,
    );
  }
  const items = input.items.filter((i) => match(i[input.sortKey]));
  const pkValues = items.map((i) => scalar(i[input.partitionKey])).filter((v): v is string => v !== undefined);
  const { partitionKey, keys } = inferPartitionKey(input.partitionKey, pkValues, notes);
  notes.push(
    `Keys found: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ` and ${keys.length - 10} more` : ''}. keys.pattern is a proposal based on their shape (not all keys were read)`,
  );
  const exclude = new Set([input.partitionKey, input.sortKey, ...input.tableKeys]);
  const fields = inferFields(items, exclude, notes);
  if (fields.length === 0) notes.push('No attributes other than the keys were found. List the attributes to return in fields');

  return {
    name: input.name || datasetName(input.table),
    dataset: {
      description: `${input.table}${input.index ? ` (${input.index})` : ''}`,
      table: input.table,
      ...(input.index ? { index: input.index } : {}),
      partitionKey,
      sortKey,
      keys: { pattern: keyPattern(keys) },
      fields: fields.length > 0 ? fields : [{ name: 'value', type: 'number' }],
    },
    notes: [...new Set(notes)],
  };
}

/** テーブル名からデータセット名を作る（英小文字で始まり、英小文字・数字・_ のみ、64 文字以内） */
export const datasetName = (table: string): string =>
  table
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64) || 'my_dataset';

/**
 * ソートキーの時刻形式とプレフィックス。
 * シングルテーブル設計では種類の違うアイテム（TEMP# と HUM#、登録用アイテムなど）が混ざるため、
 * 多数派の形式を採用し、それに合うかどうかを判定する関数（match）も返す
 */
export function inferSortKey(
  name: string,
  values: AttributeValue[],
  notes: string[],
): { sortKey: Record<string, string>; match: (v: AttributeValue | undefined) => boolean } {
  const notePrefixes = (counts: Map<string, number>, chosen: string) => {
    if (counts.size <= 1) return;
    const list = [...counts].map(([p, n]) => `${p || '(none)'}: ${n}`).join(', ');
    notes.push(
      `The sort key has multiple types (${list}). Inferred from the most common one, ${chosen || '(no prefix)'}. Define the other types as separate datasets with a different prefix`,
    );
  };

  // 数値: 1e8 未満は時刻ではない値（登録用アイテムの連番など）とみなす
  const nums = values.filter((v) => v.N !== undefined && Number(v.N) >= 1e8);
  if (nums.length > 0 && nums.length * 2 >= values.length) {
    const ms = nums.filter((v) => Number(v.N) >= 1e11).length * 2 >= nums.length;
    const [lo, hi] = ms ? [1e11, 1e14] : [1e8, 1e11];
    return { sortKey: { name, format: ms ? 'epoch_ms' : 'epoch_s' }, match: (v) => v?.N !== undefined && Number(v.N) >= lo && Number(v.N) < hi };
  }

  const strings = values.flatMap((v) => (v.S !== undefined ? [v.S] : []));
  // ISO 8601（プレフィックスつきを含む）
  const isoMatches = strings.map((s) => ISO.exec(s)).filter((m): m is RegExpExecArray => m !== null);
  if (isoMatches.length > 0 && isoMatches.length * 2 >= values.length) {
    const [prefix, counts] = majority(isoMatches.map((m) => m[1]));
    notePrefixes(counts, prefix);
    if (!isoMatches.filter((m) => m[1] === prefix).every((m) => m[3])) {
      notes.push('The sort key has no time zone. If times are stored in a zone other than UTC, set sortKey.timezone (e.g. Asia/Tokyo)');
    }
    return { sortKey: { name, format: 'iso8601', ...(prefix ? { prefix } : {}) }, match: (v) => v?.S !== undefined && ISO.exec(v.S)?.[1] === prefix };
  }

  // TEMP#1730000000 のようなプレフィックス + 数値
  const prefixed = strings.map((s) => PREFIXED_EPOCH.exec(s)).filter((m): m is RegExpExecArray => m !== null);
  if (prefixed.length > 0 && prefixed.length * 2 >= values.length) {
    const [prefix, counts] = majority(prefixed.map((m) => m[1]));
    notePrefixes(counts, prefix);
    const ms = prefixed.find((m) => m[1] === prefix)?.[2].length === 13;
    const re = new RegExp(`^${escapeRegExp(prefix)}\\d{${ms ? 13 : 10}}$`);
    return { sortKey: { name, format: ms ? 'epoch_ms' : 'epoch_s', prefix }, match: (v) => v?.S !== undefined && re.test(v.S) };
  }

  notes.push(`Could not infer the time format of the sort key (e.g. ${scalar(values[0])}). Check format`);
  return { sortKey: { name, format: 'epoch_ms' }, match: () => true };
}

/**
 * パーティションキーのテンプレートと、見つかったキー。
 * 区切り文字（# : | /）で分け、アイテムごとに変わる部分を {key}、変わらない部分（room# や #2025-11-03）をテンプレートに残す
 */
export function inferPartitionKey(name: string, values: string[], notes: string[]): { partitionKey: Record<string, string>; keys: string[] } {
  const bucket =
    values.length > 0 && values.every((s) => DATE.test(s)) ? 'daily' : values.length > 0 && values.every((s) => MONTH.test(s)) ? 'monthly' : 'none';
  const token = bucket === 'daily' ? '{yyyy-MM-dd}' : '{yyyy-MM}';
  const stripped = bucket === 'none' ? values : values.map((s) => s.replace(bucket === 'daily' ? DATE : /\d{4}-\d{2}/, DATE_PLACEHOLDER));
  if (bucket !== 'none') notes.push(`The partition key is split by date (bucket: ${bucket}). If the date boundary is not UTC, set partitionKey.timezone`);

  const distinct = [...new Set(stripped)];
  if (distinct.length === 0) return { partitionKey: { name }, keys: [] };
  const segs = distinct.map((s) => s.split(SEP)); // 偶数番目が値、奇数番目が区切り文字
  if (!segs.every((x) => x.length === segs[0].length)) {
    notes.push('Could not infer template because the partition key shape differs between items. Check partitionKey.template');
    return {
      partitionKey: { name, ...(bucket !== 'none' ? { template: `{key}#${token}`, bucket } : {}) },
      keys: distinct.map((s) => s.replace(DATE_PLACEHOLDER, '')),
    };
  }
  let idx = segs[0].flatMap((_, i) => (segs.some((x) => x[i] !== segs[0][i]) ? [i] : []));
  if (idx.length === 0) {
    // 1 種類しか見つからない場合は、日付以外の最後の値をキーとみなす（room#a → room#{key}）
    const candidates = segs[0].flatMap((t, i) => (i % 2 === 0 && t !== DATE_PLACEHOLDER ? [i] : []));
    idx = [candidates[candidates.length - 1]];
  }
  const [lo, hi] = [Math.min(...idx), Math.max(...idx)];
  const template = `${segs[0].slice(0, lo).join('')}{key}${segs[0].slice(hi + 1).join('')}`.replace(DATE_PLACEHOLDER, token);
  const keys = [...new Set(segs.map((x) => x.slice(lo, hi + 1).join('')))].sort();
  return { partitionKey: { name, ...(template !== '{key}' ? { template } : {}), ...(bucket !== 'none' ? { bucket } : {}) }, keys };
}

/** 見つかったキーの形から pattern を作る（room-01 → ^room-[0-9]{2}$）。先頭の数十件では全部のキーは見つからないため */
export function keyPattern(keys: string[]): string {
  if (keys.length === 0) return GENERIC_KEY_PATTERN;
  const exact = (k: string) => k.replace(/[0-9]+|[^0-9]/g, (t) => (/[0-9]/.test(t) ? (t.length === 1 ? '[0-9]' : `[0-9]{${t.length}}`) : escapeRegExp(t)));
  const loose = (k: string) =>
    k.replace(/[0-9]+|[a-z]+|[A-Z]+|[^0-9a-zA-Z]/g, (t) =>
      /[0-9]/.test(t) ? '[0-9]+' : /[a-z]/.test(t) ? '[a-z]+' : /[A-Z]/.test(t) ? '[A-Z]+' : escapeRegExp(t),
    );
  for (const shape of [exact, loose]) {
    const shapes = new Set(keys.map(shape));
    if (shapes.size === 1) return `^${[...shapes][0]}$`;
  }
  return GENERIC_KEY_PATTERN;
}

/** 属性の型（数値の文字列は number、Map / List / Set は json、混在は string） */
export function inferFields(items: Item[], exclude: Set<string>, notes: string[]): { name: string; type: string }[] {
  const types = new Map<string, Set<string>>();
  for (const item of items) {
    for (const [name, v] of Object.entries(item)) {
      if (exclude.has(name)) continue;
      const t =
        v.N !== undefined
          ? 'number'
          : v.BOOL !== undefined
            ? 'boolean'
            : v.S !== undefined
              ? /^-?\d+(\.\d+)?$/.test(v.S)
                ? 'number'
                : 'string'
              : v.NULL
                ? 'null'
                : 'json';
      if (!types.has(name)) types.set(name, new Set());
      types.get(name)?.add(t);
      if (v.M) notes.push(`${name} is a Map. To use a value inside it as a column, write ${name}.${Object.keys(v.M)[0] ?? 'child'}`);
    }
  }
  return [...types].map(([name, ts]) => {
    ts.delete('null');
    if (ts.size > 1) notes.push(`${name} has mixed types (${[...ts].join(' / ')}). Check type`);
    return { name, type: ts.size === 1 ? [...ts][0] : 'string' };
  });
}
