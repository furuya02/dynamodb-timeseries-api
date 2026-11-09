import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lambda/api/errors';
import { columnName, convert, getPath, projection, selectColumns, toJson, toValues } from '../../lambda/api/transform';
import type { Field } from '../../lambda/api/types';
import { base } from './helpers';

const f = (x: Partial<Field>): Field => ({ name: 'v', type: 'number', ...x }) as Field;

describe('columnName / selectColumns', () => {
  const d = base({ fields: [{ name: 'temperature', alias: 'temp_c' }, { name: 'meta.fw', type: 'string' }, { name: 'humidity' }] });

  it('alias、なければ . を _ にした名前', () => {
    expect(d.fields.map(columnName)).toEqual(['temp_c', 'meta_fw', 'humidity']);
  });

  it('未指定なら全列、指定すればその順（列名・属性名のどちらでも、重複は 1 つ）', () => {
    expect(selectColumns(d, undefined).map((c) => c.column)).toEqual(['temp_c', 'meta_fw', 'humidity']);
    expect(selectColumns(d, 'humidity, temperature,humidity').map((c) => c.column)).toEqual(['humidity', 'temp_c']);
    expect(selectColumns(d, 'meta.fw')[0].path).toEqual(['meta', 'fw']);
  });

  it('定義にない列は 400 と使える列の一覧', () => {
    expect(() => selectColumns(d, 'secret')).toThrow(ApiError);
    expect(() => selectColumns(d, 'secret')).toThrow('使える列: temp_c, meta_fw, humidity');
  });
});

describe('projection', () => {
  const cols = (...paths: string[][]) => paths.map((path) => ({ column: path.join('_'), path, field: f({}) }));

  it('すべてプレースホルダにする（予約語対策）', () => {
    const p = projection('ts', cols(['date'], ['count']));
    expect(p.expression).toBe('#sk, #f0_0, #f1_0');
    expect(p.names).toEqual({ '#sk': 'ts', '#f0_0': 'date', '#f1_0': 'count' });
  });

  it('重なるパス（meta と meta.fw）と同じパスは、短い方を 1 つだけ読む', () => {
    const p = projection('ts', cols(['meta', 'fw'], ['meta'], ['meta'], ['x']));
    expect(p.expression).toBe('#sk, #f0_0, #f1_0');
    expect(Object.values(p.names)).toEqual(['ts', 'meta', 'x']);
  });

  it('ネスト属性は . でつなぐ', () => {
    expect(projection('ts', cols(['a', 'b', 'c'])).expression).toBe('#sk, #f0_0.#f0_1.#f0_2');
  });
});

describe('getPath / toValues', () => {
  it('ネストを辿り、途中がなければ undefined', () => {
    expect(getPath({ a: { b: { c: 1 } } }, ['a', 'b', 'c'])).toBe(1);
    expect(getPath({ a: 1 }, ['a', 'b'])).toBeUndefined();
    expect(getPath({ a: new Set([1]) }, ['a', 'size'])).toBeUndefined();
  });

  it('列名 → 変換後の値', () => {
    const d = base({
      fields: [
        { name: 'v', scale: 0.1 },
        { name: 'm.x', type: 'string' },
      ],
    });
    expect(toValues({ v: 215, m: { x: 1 } }, selectColumns(d, undefined))).toEqual({ v: 21.5, m_x: '1' });
  });
});

describe('convert', () => {
  it.each([
    [42, 42],
    ['45.5', 45.5],
    [' ', null],
    ['abc', null],
    [true, null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    [undefined, null],
  ])('number: %j → %j', (v, expected) => {
    expect(convert(v, f({ type: 'number' }))).toBe(expected);
  });

  it('number の scale は有効数字 12 桁で丸める（3 × 0.1 = 0.3）', () => {
    expect(convert(3, f({ scale: 0.1 }))).toBe(0.3);
  });

  it.each([
    [true, true],
    [1, true],
    [0, false],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['no', null],
  ])('boolean: %j → %j', (v, expected) => {
    expect(convert(v, f({ type: 'boolean' }))).toBe(expected);
  });

  it('string: 数値は文字列、Map は JSON', () => {
    expect(convert(1.5, f({ type: 'string' }))).toBe('1.5');
    expect(convert({ a: 1 }, f({ type: 'string' }))).toBe('{"a":1}');
  });

  it('json: Set は配列、Binary は Base64', () => {
    expect(convert(new Set(['p', 'q']), f({ type: 'json' }))).toBe('["p","q"]');
    expect(toJson({ b: new Uint8Array([1, 2, 3]) })).toBe('{"b":"AQID"}');
  });
});
