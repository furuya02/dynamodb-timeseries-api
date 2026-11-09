import { ConfigError, type ResolvedDataset } from './config';

// ---------------------------------------------------------------
// デプロイ時のオプション（cdk deploy -c 名前=値）
// ---------------------------------------------------------------

export const exposures = ['restPublic', 'functionUrl', 'restPrivate'] as const; // 公開形態
export const auths = ['iam', 'apiKey'] as const; // 認証方式
export const coldIngests = ['scheduled', 'stream'] as const; // コールドストアへの取り込み方法
export const coldRemovalPolicies = ['retain', 'destroy'] as const; // cdk destroy のときのコールドストアのバケット

export interface DeployOptions {
  exposure: (typeof exposures)[number];
  auth: (typeof auths)[number];
  vpcEndpointId?: string; // restPrivate のときの既存 VPC エンドポイント（execute-api）
  grafanaUser: boolean; // Grafana 用の IAM ユーザーを作る
  grafanaRoleTrust?: string; // このプリンシパル（ARN）が引き受けられるロールを作る
  logRetentionDays: number; // CloudWatch Logs の保持日数
  throttleRate: number; // apiKey の使用量プラン（1 秒あたりのリクエスト数）
  throttleBurst: number;
  sample: boolean; // サンプルテーブルを作る
  cold: boolean; // コールドストア（S3 + Glue + Athena）を作る
  coldIngest: (typeof coldIngests)[number]; // scheduled: 1 日 1 回、前日分を取り込む / stream: DynamoDB Streams から数分おきに取り込む
  coldScanLimitGb: number; // Athena が 1 回の問い合わせで読む量の上限（ワークグループに設定）
  coldRemovalPolicy: (typeof coldRemovalPolicies)[number]; // retain: バケットを残す（既定）/ destroy: 中身ごと消す
  bucketSuffix?: string; // S3 バケット名のサフィックス（既定はアカウント ID）
}

// CloudWatch Logs で指定できる保持日数
const RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

export function readOptions(get: (key: string) => unknown): DeployOptions {
  const errors: string[] = [];
  const str = (key: string) => {
    const v = get(key);
    return v === undefined || v === null || v === '' ? undefined : String(v);
  };
  const oneOf = <T extends string>(key: string, list: readonly T[], def: T): T => {
    const v = str(key) ?? def;
    if (!(list as readonly string[]).includes(v)) errors.push(`-c ${key}=${v}: ${list.join(' / ')} のいずれかを指定してください`);
    return v as T;
  };
  const int = (key: string, def: number, ok: (n: number) => boolean, hint: string) => {
    const v = str(key);
    const n = v === undefined ? def : Number(v);
    if (!Number.isInteger(n) || !ok(n)) errors.push(`-c ${key}=${v}: ${hint}`);
    return n;
  };

  const exposure = oneOf('exposure', exposures, 'restPublic');
  const auth = oneOf('auth', auths, 'iam');
  const vpcEndpointId = str('vpcEndpointId');
  const grafanaUser = str('grafanaUser') === 'true';
  const sample = str('sample') === 'true';
  const grafanaRoleTrust = str('grafanaRoleTrust');
  const logRetentionDays = int('logRetentionDays', 7, (n) => RETENTION_DAYS.includes(n), `${RETENTION_DAYS.join(' / ')} のいずれかを指定してください`);
  const throttleRate = int('throttleRate', 10, (n) => n > 0, '1 以上の整数を指定してください');
  const throttleBurst = int('throttleBurst', 20, (n) => n > 0, '1 以上の整数を指定してください');
  const cold = str('cold') === 'true';
  const coldIngest = oneOf('coldIngest', coldIngests, 'scheduled');
  const coldScanLimitGb = int('coldScanLimitGb', 1, (n) => n >= 1 && n <= 1024, '1〜1024 の整数（GB）を指定してください');
  const coldRemovalPolicy = oneOf('coldRemovalPolicy', coldRemovalPolicies, 'retain');
  const bucketSuffix = str('bucket_suffix');

  // 組み合わせの確認
  if (exposure === 'functionUrl' && auth === 'apiKey')
    errors.push('-c auth=apiKey は REST API（restPublic / restPrivate）でだけ使えます。関数 URL は IAM 認証のみです');
  if (exposure === 'restPrivate' && !vpcEndpointId)
    errors.push('-c exposure=restPrivate のときは -c vpcEndpointId=vpce-xxxx（execute-api の VPC エンドポイント）を指定してください');
  if (exposure !== 'restPrivate' && vpcEndpointId) errors.push('-c vpcEndpointId は exposure=restPrivate のときだけ指定できます');
  if (vpcEndpointId && !/^vpce-[0-9a-f]{8,17}$/.test(vpcEndpointId)) errors.push(`-c vpcEndpointId=${vpcEndpointId}: vpce- で始まる ID を指定してください`);
  if (grafanaRoleTrust && !/^arn:aws[a-z-]*:iam::\d{12}:(root|role\/.+|user\/.+)$/.test(grafanaRoleTrust)) {
    errors.push(`-c grafanaRoleTrust=${grafanaRoleTrust}: IAM ロール / ユーザー / アカウント（:root）の ARN を指定してください`);
  }
  if (auth === 'apiKey' && (grafanaUser || grafanaRoleTrust))
    errors.push('-c grafanaUser / grafanaRoleTrust は auth=iam のときだけ使えます（API キー認証では IAM の権限を使わないため）');

  if (!cold && (str('coldIngest') || str('coldScanLimitGb') || str('coldRemovalPolicy')))
    errors.push('-c coldIngest / coldScanLimitGb / coldRemovalPolicy は -c cold=true のときだけ指定できます');
  if (bucketSuffix && !/^[a-z0-9][a-z0-9-]{0,24}$/.test(bucketSuffix))
    errors.push(`-c bucket_suffix=${bucketSuffix}: 英小文字・数字・- の 25 文字以内で指定してください`);

  if (errors.length > 0) throw new ConfigError(`デプロイオプションに誤りがあります\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return {
    exposure,
    auth,
    vpcEndpointId,
    grafanaUser,
    grafanaRoleTrust,
    logRetentionDays,
    throttleRate,
    throttleBurst,
    sample,
    cold,
    coldIngest,
    coldScanLimitGb,
    coldRemovalPolicy,
    bucketSuffix,
  };
}

/** 設定ファイルとデプロイオプションの食い違いを確かめる（cold を書いたデータセットがあるのに -c cold=true がない、など） */
export function checkOptionsAgainstConfig(datasets: Record<string, ResolvedDataset>, o: DeployOptions): void {
  const errors: string[] = [];
  const coldNames = Object.entries(datasets)
    .filter(([, d]) => d.cold)
    .map(([name]) => name);
  if (coldNames.length > 0 && !o.cold) {
    errors.push(`datasets.yaml の ${coldNames.join(', ')} に cold がありますが、-c cold=true が指定されていません（コールドストアが作られません）`);
  }
  if (o.cold && coldNames.length === 0) {
    errors.push('-c cold=true が指定されていますが、datasets.yaml に cold を書いたデータセットがありません');
  }
  if (o.cold && o.coldIngest === 'scheduled') {
    // 定期実行は前日分を Query で読むため、キーを列挙できる必要がある（Scan はしない）
    for (const name of coldNames) {
      const d = datasets[name];
      if (!d.keys.values && !d.keys.list) {
        errors.push(`datasets.${name}: -c coldIngest=scheduled では、キーを列挙するため keys.values か keys.list が必要です（Scan はしません）`);
      }
    }
  }
  if (errors.length > 0) throw new ConfigError(`設定ファイルとデプロイオプションが合っていません\n${errors.map((e) => `  - ${e}`).join('\n')}`);
}
