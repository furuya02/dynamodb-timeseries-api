import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { handler } from '../../lambda/api/index';

// 生成される設定 JSON と DynamoDB のクライアントを差し替える
vi.mock('../../lambda/api/datasets.generated.json', () => ({
  default: {
    ds: {
      table: 'tbl',
      partitionKey: { name: 'pk', template: '{key}', bucket: 'none', timezone: 'UTC' },
      sortKey: { name: 'ts', format: 'epoch_ms', prefix: '', timezone: 'UTC' },
      keys: { values: ['a'] },
      fields: [{ name: 'value', type: 'number' }],
      limits: { maxRange: '31d', maxItems: 50000, maxPages: 100, maxRcu: 1000, maxKeys: 20 },
      cacheTtlSeconds: 30,
    },
  },
}));

const context = { awsRequestId: 'req-1' } as Context;

// vi.mock はファイルの先頭に巻き上げられるため、上の import より先に差し替わる
describe('handler', () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  it('REST API（event.path）を受け、JSON の応答にする', async () => {
    const r = await handler({ path: '/datasets', queryStringParameters: null } as unknown as APIGatewayProxyEvent, context);
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(r.body)[0].name).toBe('ds');
  });

  it('関数 URL（event.rawPath）を受ける', async () => {
    const r = await handler({ rawPath: '/keys', queryStringParameters: { dataset: 'ds' } } as unknown as APIGatewayProxyEventV2, context);
    expect(JSON.parse(r.body)).toEqual([{ key: 'a' }]);
  });

  it('ログにリクエスト ID を付ける', async () => {
    write.mockClear();
    await handler({ path: '/v1/foo' } as unknown as APIGatewayProxyEvent, context);
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({ requestId: 'req-1', type: 'unknown', status: 404, path: '/v1/foo' });
  });
});
