// ---------------------------------------------------------------
// API の処理全体（パスの振り分け → 検証 → キャッシュ → 読み込み → 集計・整形 → 構造化ログ）
// Lambda（index.ts）とローカル実行（scripts/local-api.ts）、テストから同じ形で使う
// ---------------------------------------------------------------
import { ResponseCache } from './cache';
import { findDataset, type KeyList, listDatasets, listKeys } from './catalog';
import type { ColdReader, ColdResult } from './cold/reader';
import { ApiError } from './errors';
import { type QueryClient, readRows } from './reader';
import { parseQueryRequest, type QueryParams } from './request';
import { measureResponse, type QueryResponse, toResponse } from './response';
import { splitRange } from './split';
import type { ApiResult, Datasets, Logger, QueryRequest, ReadResult } from './types';

export interface ApiDependencies {
  datasets: Datasets;
  client: QueryClient;
  cache?: ResponseCache;
  /** コールドストアの読み込み。なければ cold を設定したデータセットも DynamoDB だけを読む */
  cold?: ColdReader;
  /** 1 リクエスト = 1 行の構造化ログ */
  log?: Logger;
  /** 現在時刻（ミリ秒）。所要時間の計測に使う */
  now?: () => number;
}

export interface Api {
  /** GET /query /datasets /keys */
  handle(path: string, params: Record<string, string | undefined>): Promise<ApiResult>;
}

/**
 * console.log は行頭に時刻・リクエスト ID・ログレベルを付けるため、行全体が JSON にならない。
 * stdout に直接書くと、その行がそのまま 1 つのログイベントになり、CloudWatch Logs Insights で項目として扱える
 */
export const writeLog: Logger = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const NO_KEY_LIST_HINT = 'keys.values or keys.list is required to list keys';

export function createApi(deps: ApiDependencies): Api {
  const { datasets, client } = deps;
  const cache = deps.cache ?? new ResponseCache();
  const log = deps.log ?? writeLog;
  const now = deps.now ?? Date.now;

  /** ホットとコールドを並行して読み、1 つの応答にする */
  async function query(req: QueryRequest): Promise<QueryResponse> {
    const { cold: coldReader } = deps;
    const split = coldReader ? splitRange(req, now()) : { hot: { from: req.from, to: req.to } };
    const readHot = (): Promise<ReadResult | undefined> => (split.hot ? readRows(client, { ...req, ...split.hot }) : Promise.resolve(undefined));
    if (req.latest && split.hot && split.cold && coldReader) {
      // 最新値は、ホットで見つからなかったキーだけコールドを読む（Athena の費用と待ち時間を避ける）
      const hot = await readHot();
      const missing = req.keys.filter((k) => !hot?.rows.some((r) => r.key === k));
      const cold = missing.length > 0 ? await coldReader.read({ ...req, keys: missing }, split.cold.from, split.cold.to) : undefined;
      return toResponse(req, hot, cold);
    }
    const [hot, cold] = await Promise.all([
      readHot(),
      split.cold && coldReader ? coldReader.read(req, split.cold.from, split.cold.to) : Promise.resolve<ColdResult | undefined>(undefined),
    ]);
    return toResponse(req, hot, cold);
  }

  async function handleQuery(params: QueryParams): Promise<ApiResult> {
    const started = now();
    let req: QueryRequest | undefined;
    let meta: QueryResponse['meta'] | undefined;
    let cacheState: 'hit' | 'miss' | undefined;
    let result: ApiResult;
    try {
      req = parseQueryRequest(datasets, params);
      const key = queryCacheKey(req);
      const hit = cache.get<QueryResponse>(key);
      cacheState = hit ? 'hit' : 'miss';
      const body = hit ?? (await query(req));
      if (!hit) cache.set(key, body, req.dataset.cacheTtlSeconds, measureResponse(body));
      meta = body.meta;
      result = { status: 200, body: { ...body, meta: { ...body.meta, cache: cacheState } } };
    } catch (e) {
      result = errorResult(e);
    }
    const read = cacheState === 'miss' ? meta : undefined; // キャッシュに当たったときは DynamoDB を読んでいない
    log({
      type: 'query',
      status: result.status,
      dataset: params.dataset,
      keys: req?.keys.length,
      rangeMs: req ? req.to - req.from : undefined,
      interval: req?.interval,
      agg: req?.interval === undefined ? undefined : req.agg,
      latest: req?.latest || undefined,
      format: req?.format,
      cache: cacheState,
      queries: read?.queries,
      pages: read?.pages,
      items: read?.items,
      consumedRcu: read?.consumedRcu,
      coldBytesScanned: read?.cold?.bytesScanned,
      coldEngineMs: read?.cold?.engineMs,
      truncatedBy: meta?.truncatedBy,
      points: meta?.points,
      durationMs: now() - started,
      error: errorMessage(result),
    });
    return result;
  }

  async function handleKeys(name: string | undefined): Promise<ApiResult> {
    const started = now();
    let list: KeyList | undefined;
    let cacheState: 'hit' | 'miss' | undefined;
    let result: ApiResult;
    try {
      const d = findDataset(datasets, name);
      const key = JSON.stringify(['keys', name]);
      const hit = cache.get<KeyList>(key);
      cacheState = hit ? 'hit' : 'miss';
      list = hit ?? (await listKeys(client, d));
      if (!hit && list.source === 'list') cache.set(key, list, d.cacheTtlSeconds, Buffer.byteLength(JSON.stringify(list)));
      // 一覧を作れない設定のときは、空の配列に理由をヘッダーで添える（ルートは配列のまま保つ）
      result = { status: 200, body: list.keys, headers: list.source === 'none' ? { 'x-tsapi-hint': NO_KEY_LIST_HINT } : undefined };
    } catch (e) {
      result = errorResult(e);
    }
    log({
      type: 'keys',
      status: result.status,
      dataset: name,
      source: list?.source,
      count: list?.keys.length,
      cache: cacheState,
      consumedRcu: cacheState === 'miss' ? list?.consumedRcu : undefined,
      durationMs: now() - started,
      error: errorMessage(result),
    });
    return result;
  }

  return {
    // REST API のステージ名やカスタムドメインのベースパスが前に付いても動くよう、パスの末尾で判定する
    async handle(path, params) {
      const p = path.replace(/\/+$/, '');
      if (p.endsWith('/query')) return handleQuery(params);
      if (p.endsWith('/keys')) return handleKeys(params.dataset);
      if (p.endsWith('/datasets')) {
        log({ type: 'datasets', status: 200 });
        return { status: 200, body: listDatasets(datasets) };
      }
      log({ type: 'unknown', status: 404, path });
      return { status: 404, body: { error: 'The path must be /query, /datasets, or /keys' } };
    },
  };
}

/** 結果が同じになるリクエストは同じキーにする（キーの並び順は結果に影響しないので並べ替える） */
export const queryCacheKey = (r: QueryRequest): string =>
  JSON.stringify([r.name, [...r.keys].sort(), r.columns.map((c) => c.column), r.from, r.to, r.interval, r.agg, r.latest, r.format, r.tz]);

/** ApiError は理由をそのまま、それ以外（DynamoDB のエラーなど）は設定の見直しに使えるようエラー名と内容を返す */
export function errorResult(e: unknown): ApiResult {
  if (e instanceof ApiError) return { status: e.status, body: { error: e.message } };
  console.error(e);
  const err = e as Error;
  return { status: 500, body: { error: `${err.name}: ${err.message}` } };
}

const errorMessage = (r: ApiResult): string | undefined => (r.status === 200 ? undefined : (r.body as { error: string }).error);
