// ---------------------------------------------------------------
// 呼び出し先（エンドポイント）と認証方式
// ---------------------------------------------------------------

export type Auth = { type: 'iam'; service: 'execute-api' | 'lambda'; region: string } | { type: 'apiKey'; key: string } | { type: 'none' };

export interface Target {
  /** 末尾が / のベース URL */
  endpoint: string;
  auth: Auth;
}

/** 末尾を / にそろえる */
export const withTrailingSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`);

/** 関数 URL か（SigV4 のサービス名が lambda になる） */
export const isFunctionUrl = (url: string): boolean => new URL(url).hostname.includes('.lambda-url.');

/**
 * 認証方式を決める。API キーがあれば API キー、localhost なら認証なし（pnpm local-api）、それ以外は IAM（SigV4）
 */
export function resolveAuth(endpoint: string, region: string, apiKey?: string): Auth {
  if (apiKey) return { type: 'apiKey', key: apiKey };
  const host = new URL(endpoint).hostname;
  if (host === 'localhost' || host === '127.0.0.1') return { type: 'none' };
  return { type: 'iam', service: isFunctionUrl(endpoint) ? 'lambda' : 'execute-api', region };
}

export function describeAuth(auth: Auth): string {
  if (auth.type === 'iam') return `IAM (SigV4, service ${auth.service}, ${auth.region})`;
  if (auth.type === 'apiKey') return 'API key';
  return 'none (local)';
}
