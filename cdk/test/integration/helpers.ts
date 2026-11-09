import * as path from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createApi } from '../../lambda/api/app';
import { ResponseCache } from '../../lambda/api/cache';
import { readRows } from '../../lambda/api/reader';
import { parseQueryRequest, type QueryParams } from '../../lambda/api/request';
import { toResponse } from '../../lambda/api/response';
import type { LogLine } from '../../lambda/api/types';
import { loadConfig } from '../../lib/config';

// 接続先は vitest.config.ts の env（AWS_ENDPOINT_URL_DYNAMODB）で DynamoDB Local に向けている
export const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const datasets = loadConfig(path.join(__dirname, 'datasets.yaml'));

/** 検証 → 読み込み（集計・整形の前） */
export const read = (p: QueryParams) => readRows(client, parseQueryRequest(datasets, p));

/** 検証 → 読み込み → 応答の組み立て（キャッシュなし） */
export const respond = async (p: QueryParams) => {
  const req = parseQueryRequest(datasets, p);
  return toResponse(req, await readRows(client, req));
};

/** キャッシュとログを持つ API。テストごとに作り、キャッシュを分ける */
export function newApi() {
  const logs: LogLine[] = [];
  const api = createApi({ datasets, client, cache: new ResponseCache(), log: (l) => logs.push(l) });
  return { api, logs };
}

export type QueryBody = {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string; unit?: string }[];
  meta: Record<string, unknown>;
};
