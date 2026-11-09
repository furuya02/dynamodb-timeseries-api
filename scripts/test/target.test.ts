import { describe, expect, it } from 'vitest';
import { apiKeyIdOf } from '../lib/stack.ts';
import { describeAuth, isFunctionUrl, resolveAuth, withTrailingSlash } from '../lib/target.ts';

describe('resolveAuth', () => {
  it.each([
    ['https://abc.execute-api.ap-northeast-1.amazonaws.com/v1/', undefined, { type: 'iam', service: 'execute-api', region: 'ap-northeast-1' }],
    ['https://xyz.lambda-url.ap-northeast-1.on.aws/', undefined, { type: 'iam', service: 'lambda', region: 'ap-northeast-1' }],
    ['http://localhost:13000/', undefined, { type: 'none' }],
    ['http://127.0.0.1:13000/', undefined, { type: 'none' }],
    ['https://abc.execute-api.ap-northeast-1.amazonaws.com/v1/', 'k', { type: 'apiKey', key: 'k' }],
  ])('%s（API キー %s）', (endpoint, key, expected) => {
    expect(resolveAuth(endpoint, 'ap-northeast-1', key)).toEqual(expected);
  });

  it('表示用の説明', () => {
    expect(describeAuth({ type: 'iam', service: 'lambda', region: 'us-east-1' })).toBe('IAM（SigV4、サービス lambda、us-east-1）');
    expect(describeAuth({ type: 'none' })).toBe('なし（ローカル）');
  });
});

describe('URL / スタック出力', () => {
  it('withTrailingSlash / isFunctionUrl', () => {
    expect(withTrailingSlash('https://a/v1')).toBe('https://a/v1/');
    expect(withTrailingSlash('https://a/v1/')).toBe('https://a/v1/');
    expect(isFunctionUrl('https://x.lambda-url.us-east-1.on.aws/')).toBe(true);
  });

  it('GetApiKeyCommand から API キーの ID を取り出す', () => {
    expect(apiKeyIdOf({ GetApiKeyCommand: 'aws apigateway get-api-key --api-key alfw7ljble --include-value' })).toBe('alfw7ljble');
    expect(apiKeyIdOf({})).toBeUndefined();
  });
});
