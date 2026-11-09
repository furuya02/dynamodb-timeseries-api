import { describe, expect, it } from 'vitest';
import { createRequester, parseJson } from '../lib/http.ts';

/** 渡された URL とヘッダーを記録し、決まった応答を返す fetch */
function fakeFetch(status = 200, body = '{"ok":true}') {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(body, { status });
  }) as typeof fetch;
  return { f, calls };
}

describe('createRequester', () => {
  it('IAM: SigV4 で署名する（host は署名に含めるが、fetch には渡さない）', async () => {
    const { f, calls } = fakeFetch();
    const get = createRequester(
      { endpoint: 'https://abc.execute-api.ap-northeast-1.amazonaws.com/v1/', auth: { type: 'iam', service: 'execute-api', region: 'ap-northeast-1' } },
      { fetch: f, credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } },
    );
    const r = await get('query', { dataset: 'ds', key: 'a,b' });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(calls[0].url).toBe('https://abc.execute-api.ap-northeast-1.amazonaws.com/v1/query?dataset=ds&key=a%2Cb');
    expect(calls[0].headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-1\/execute-api\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date|^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-1\/execute-api\/aws4_request, SignedHeaders=host;x-amz-date/,
    );
    expect(calls[0].headers).not.toHaveProperty('host');
    expect(calls[0].headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it('API キー: x-api-key ヘッダー', async () => {
    const { f, calls } = fakeFetch();
    await createRequester({ endpoint: 'https://a/v1/', auth: { type: 'apiKey', key: 'k1' } }, { fetch: f })('datasets');
    expect(calls[0].headers).toEqual({ 'x-api-key': 'k1' });
  });

  it('認証なし: ヘッダーなし。JSON でない応答は文字列のまま、所要時間を測る', async () => {
    const { f, calls } = fakeFetch(502, 'Bad Gateway');
    let t = 0;
    const r = await createRequester({ endpoint: 'http://localhost:13000/', auth: { type: 'none' } }, { fetch: f, now: () => (t += 7) })('keys');
    expect(calls[0].headers).toEqual({});
    expect(r).toEqual({ status: 502, body: 'Bad Gateway', ms: 7 });
  });
});

describe('parseJson', () => {
  it('JSON なら解析し、そうでなければ文字列', () => {
    expect(parseJson('[1]')).toEqual([1]);
    expect(parseJson('x')).toBe('x');
  });
});
