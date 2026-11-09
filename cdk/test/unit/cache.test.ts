import { describe, expect, it } from 'vitest';
import { ResponseCache } from '../../lambda/api/cache';

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('ResponseCache', () => {
  it('TTL の間だけ値を返す', () => {
    const c = clock();
    const cache = new ResponseCache({ now: c.now });
    cache.set('k', 'v', 30, 10);
    expect(cache.get('k')).toBe('v');
    c.advance(29_999);
    expect(cache.get('k')).toBe('v');
    c.advance(1);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('TTL が 0 以下なら保持しない', () => {
    const cache = new ResponseCache();
    cache.set('k', 'v', 0, 10);
    expect(cache.get('k')).toBeUndefined();
  });

  it('上限を超える分は古いものから捨てる', () => {
    const cache = new ResponseCache({ maxBytes: 100 });
    cache.set('a', 1, 60, 25);
    cache.set('b', 2, 60, 25);
    cache.set('c', 3, 60, 25);
    cache.set('d', 4, 60, 25);
    cache.set('e', 5, 60, 25);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('e')).toBe(5);
    expect(cache.stats()).toEqual({ entries: 4, bytes: 100 });
  });

  it('1 件で上限の 1/4 を超える値は保持しない', () => {
    const cache = new ResponseCache({ maxBytes: 100 });
    cache.set('big', 1, 60, 26);
    expect(cache.get('big')).toBeUndefined();
  });

  it('同じキーは上書きし、バイト数を数え直す', () => {
    const cache = new ResponseCache({ maxBytes: 100 });
    cache.set('k', 1, 60, 10);
    cache.set('k', 2, 60, 20);
    expect(cache.get('k')).toBe(2);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 20 });
  });
});
