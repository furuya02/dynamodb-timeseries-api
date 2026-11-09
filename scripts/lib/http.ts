// ---------------------------------------------------------------
// API を呼ぶ（SigV4 署名 / API キー / 認証なし）
// ---------------------------------------------------------------
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import type { Target } from './target.ts';

export interface ApiResponse {
  status: number;
  /** JSON として読めれば解析した値、読めなければ文字列 */
  body: unknown;
  ms: number;
}

export type Get = (path: string, query?: Record<string, string>) => Promise<ApiResponse>;

export interface RequesterOptions {
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  fetch?: typeof fetch;
  now?: () => number;
}

/** GET で API を呼ぶ関数を作る。IAM 認証なら SigV4 で署名する */
export function createRequester(target: Target, options: RequesterOptions = {}): Get {
  const { auth, endpoint } = target;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const signer =
    auth.type === 'iam'
      ? new SignatureV4({ service: auth.service, region: auth.region, credentials: options.credentials ?? fromNodeProviderChain(), sha256: Sha256 })
      : undefined;

  return async (path, query = {}) => {
    const url = new URL(path, endpoint);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let headers: Record<string, string> = {};
    if (signer) {
      const signed = await signer.sign({
        method: 'GET',
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        query,
        headers: { host: url.host },
      });
      // host は署名に含めるが、fetch には渡さない（fetch が URL から同じ値を付ける）
      const { host: _host, ...rest } = signed.headers;
      headers = rest;
    } else if (auth.type === 'apiKey') {
      headers = { 'x-api-key': auth.key };
    }
    const started = now();
    const res = await doFetch(url, { headers });
    const text = await res.text();
    return { status: res.status, body: parseJson(text), ms: now() - started };
  };
}

/** JSON として読めなければ文字列のまま返す（API Gateway のエラーなど） */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
