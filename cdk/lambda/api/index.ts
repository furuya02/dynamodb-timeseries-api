// ---------------------------------------------------------------
// Lambda の入口
// REST API（ペイロード 1.0 の event.path）と関数 URL（2.0 の event.rawPath）の両方を受ける
// ---------------------------------------------------------------
import { AthenaClient } from '@aws-sdk/client-athena';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyResult, Context } from 'aws-lambda';
import { createApi, writeLog } from './app';
import { ResponseCache } from './cache';
import { createAthenaRunner } from './cold/athena';
import { type ColdReader, createColdReader } from './cold/reader';
// cdk synth のときに、検証済みの config/datasets.yaml から生成される
import generated from './datasets.generated.json';
import type { Datasets } from './types';

const datasets: Datasets = generated;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// キャッシュは実行環境（コンテナ）の寿命の間、リクエストをまたいで使う
const cache = new ResponseCache();
// コールドストア（-c cold=true でデプロイしたときに CDK が環境変数を設定する）
const { TSAPI_COLD_DATABASE: database, TSAPI_COLD_TABLE: table, TSAPI_COLD_WORKGROUP: workgroup } = process.env;
const cold: ColdReader | undefined =
  database && table && workgroup ? createColdReader(createAthenaRunner(new AthenaClient({}), { workgroup, database }), { database, table }) : undefined;

export const handler = async (event: APIGatewayProxyEvent | APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyResult> => {
  const path = 'rawPath' in event ? event.rawPath : event.path;
  // ログにリクエスト ID を付け、同じロググループの REPORT 行（所要時間・メモリ）と突き合わせられるようにする
  const log = (line: Record<string, unknown>) => writeLog({ requestId: context.awsRequestId, ...line });
  const api = createApi({ datasets, client, cache, cold, log });
  const { status, body, headers } = await api.handle(path, event.queryStringParameters ?? {});
  return { statusCode: status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
};
