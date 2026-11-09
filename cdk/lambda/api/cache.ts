// ---------------------------------------------------------------
// 応答キャッシュ（Lambda の実行環境ごとのメモリ。TTL 付き）
// 同じ実行環境に来たリクエストだけが当たる。複数の実行環境の間では共有しない
// ---------------------------------------------------------------

/** Lambda のメモリ 512MB のうち、キャッシュに使う上限 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

interface Entry {
  expires: number;
  bytes: number;
  value: unknown;
}

export interface CacheOptions {
  maxBytes?: number;
  /** 現在時刻（ミリ秒）。テストで差し替える */
  now?: () => number;
}

export class ResponseCache {
  /** Map は挿入順を保つので、先頭が最も古い */
  private readonly entries = new Map<string, Entry>();
  private total = 0;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: CacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  get<T>(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.remove(key, e);
      return undefined;
    }
    return e.value as T;
  }

  /** ttlSeconds が 0 以下、または 1 件で上限の 1/4 を超える値は保持しない。上限を超える分は古いものから捨てる */
  set(key: string, value: unknown, ttlSeconds: number, bytes: number): void {
    if (ttlSeconds <= 0 || bytes > this.maxBytes / 4) return;
    const old = this.entries.get(key);
    if (old) this.remove(key, old);
    for (const [k, e] of this.entries) {
      if (this.total + bytes <= this.maxBytes) break;
      this.remove(k, e);
    }
    this.entries.set(key, { expires: this.now() + ttlSeconds * 1000, bytes, value });
    this.total += bytes;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.total };
  }

  private remove(key: string, e: Entry): void {
    this.entries.delete(key);
    this.total -= e.bytes;
  }
}
