import * as fs from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------
// config/datasets.yaml のスキーマ
// CDK（synth 時の検証・IAM 付与）と Lambda（実行時）の両方で使う
// ---------------------------------------------------------------

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ATTR = /^[A-Za-z0-9_.-]+$/; // a.b でネスト属性を表す
const DURATION = /^[1-9][0-9]*(m|h|d)$/; // 例: 90m / 12h / 31d

export const timeFormats = ['epoch_s', 'epoch_ms', 'iso8601'] as const;
export const bucketUnits = ['none', 'daily', 'monthly'] as const;
export const fieldTypes = ['number', 'string', 'boolean', 'json'] as const;

const bucketToken: Record<(typeof bucketUnits)[number], string | undefined> = {
  none: undefined,
  daily: '{yyyy-MM-dd}',
  monthly: '{yyyy-MM}',
};

// "UTC" / "+09:00" / IANA 名（Asia/Tokyo）
const timezone = z.string().refine(
  (tz) => {
    if (tz === 'UTC' || /^[+-](0\d|1[0-4]):[0-5]\d$/.test(tz)) return true;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Use UTC, an offset such as +09:00, or an IANA name such as Asia/Tokyo' },
);

const limitsSchema = z
  .object({
    maxRange: z.string().regex(DURATION, 'Use the form 90m / 12h / 31d').optional(), // 1 回で問い合わせられる期間
    maxItems: z.number().int().positive().optional(), // 読む件数の上限
    maxPages: z.number().int().positive().optional(), // 読むページ数の上限
    maxRcu: z.number().positive().optional(), // 消費 RCU の上限
    maxKeys: z.number().int().positive().optional(), // 一度に問い合わせるキーの数
  })
  .strict();

const fieldSchema = z
  .object({
    name: z.string().regex(ATTR, 'Contains characters that cannot be used in an attribute name'), // a.b でネスト属性
    alias: z.string().min(1).optional(), // 列名
    type: z.enum(fieldTypes).default('number'), // 値をこの型にそろえる
    unit: z.string().min(1).optional(), // 単位（応答の columns で返す）
    scale: z.number().optional(), // 掛け算での換算
  })
  .strict()
  .refine((f) => f.scale === undefined || f.type === 'number', { message: 'scale can be used only with type: number', path: ['scale'] });

export const coldTypes = ['athena'] as const;

// コールドストア（直近より前のデータを S3 + Athena から読む）。書かなければ DynamoDB だけを読む
const coldSchema = z
  .object({
    type: z.enum(coldTypes).default('athena'), // 読み先の種類（今は Athena のみ）
    hotRetention: z.string().regex(DURATION, 'Use the form 90m / 12h / 7d').default('7d'), // これより前はコールドストアから読む
    maxRange: z.string().regex(DURATION, 'Use the form 90m / 12h / 400d').default('400d'), // 1 回で問い合わせられる期間（limits.maxRange の代わりに使う）
  })
  .strict();

const datasetSchema = z
  .object({
    description: z.string().optional(),
    table: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/, 'Not a valid DynamoDB table name'),
    index: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{3,255}$/)
      .optional(), // GSI
    partitionKey: z
      .object({
        name: z.string().regex(ATTR),
        template: z.string().default('{key}'), // 例: room#{key}
        bucket: z.enum(bucketUnits).default('none'), // 日付で分けたキー
        timezone: timezone.default('UTC'), // 日付の区切りに使うタイムゾーン
      })
      .strict(),
    sortKey: z
      .object({
        name: z.string().regex(ATTR),
        format: z.enum(timeFormats),
        prefix: z.string().default(''), // 複合ソートキーのプレフィックス。例: TEMP#
        timezone: timezone.default('UTC'), // オフセットのない ISO 8601 の解釈
      })
      .strict(),
    keys: z
      .object({
        pattern: z.string().optional(), // 受け付けるキーの正規表現
        values: z.array(z.string().min(1)).min(1).optional(), // 受け付けるキーの列挙（GET /keys でも返す）
        // キー一覧（Grafana のプルダウン）を、同じテーブルの登録用アイテムから読む
        // 例: { partitionValue: devices, attribute: deviceId } → パーティションキー = "devices" のアイテムの deviceId を返す
        list: z
          .object({
            partitionValue: z.string().min(1),
            attribute: z.string().regex(ATTR, 'Contains characters that cannot be used in an attribute name'),
          })
          .strict()
          .optional(),
      })
      .strict(),
    fields: z.array(fieldSchema).min(1), // 返す属性（ここにない属性は返さない）
    limits: limitsSchema.default({}),
    cacheTtlSeconds: z.number().int().min(0).optional(), // 応答キャッシュの秒数（0 で無効）
    cold: coldSchema.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const pk = d.partitionKey;
    if (!pk.template.includes('{key}')) {
      ctx.addIssue({ code: 'custom', path: ['partitionKey', 'template'], message: 'Include {key}' });
    }
    const token = bucketToken[pk.bucket];
    if (token && !pk.template.includes(token)) {
      ctx.addIssue({ code: 'custom', path: ['partitionKey', 'template'], message: `Include ${token} when bucket is ${pk.bucket}` });
    }
    if (!token && /\{yyyy/.test(pk.template)) {
      ctx.addIssue({
        code: 'custom',
        path: ['partitionKey', 'bucket'],
        message: 'The template contains a date. Set bucket: daily or monthly',
      });
    }
    if (pk.bucket === 'none' && pk.timezone !== 'UTC') {
      ctx.addIssue({ code: 'custom', path: ['partitionKey', 'timezone'], message: 'timezone can be used only with bucket: daily / monthly' });
    }
    if (d.keys.pattern === undefined && d.keys.values === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['keys'],
        message: 'Specify pattern or values (to restrict the accepted keys; list is only for listing keys and does not restrict them)',
      });
    }
    if (d.keys.pattern !== undefined) {
      try {
        new RegExp(d.keys.pattern);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['keys', 'pattern'], message: 'Not a valid regular expression' });
      }
    }
    if (d.sortKey.format !== 'iso8601' && d.sortKey.timezone !== 'UTC') {
      ctx.addIssue({ code: 'custom', path: ['sortKey', 'timezone'], message: 'timezone can be used only with format: iso8601 (epoch is always UTC)' });
    }
    const names = new Set<string>();
    d.fields.forEach((f, i) => {
      const label = f.alias ?? f.name.replaceAll('.', '_'); // 応答の列名（lambda/api/transform.ts の columnName と同じ）
      if (names.has(label)) ctx.addIssue({ code: 'custom', path: ['fields', i], message: `Duplicate column name ${label}` });
      names.add(label);
      if (f.name === d.sortKey.name)
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'name'],
          message: 'Do not list the sort key in fields (it is returned automatically as the time column)',
        });
    });
  });

const defaultsSchema = z
  .object({
    limits: limitsSchema.default({}),
    cacheTtlSeconds: z.number().int().min(0).default(30),
  })
  .strict();

export const configSchema = z
  .object({
    defaults: defaultsSchema.default({ limits: {}, cacheTtlSeconds: 30 }),
    datasets: z.record(z.string(), datasetSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
    // キー名の誤りで他の項目の検証が止まらないよう、名前はここでまとめて確認する
    if (Object.keys(c.datasets).length === 0) ctx.addIssue({ code: 'custom', path: ['datasets'], message: 'Define at least one dataset' });
    for (const name of Object.keys(c.datasets)) {
      if (!NAME.test(name))
        ctx.addIssue({
          code: 'custom',
          path: ['datasets', name],
          message: 'Dataset names must start with a lowercase letter and contain only lowercase letters, digits, and _ (up to 64 characters)',
        });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type Dataset = z.infer<typeof datasetSchema>;

// 既定値（defaults）をデータセットに反映した最終形
export const builtinLimits = { maxRange: '31d', maxItems: 50000, maxPages: 100, maxRcu: 1000, maxKeys: 20 };
export type ResolvedDataset = Omit<Dataset, 'limits' | 'cacheTtlSeconds'> & {
  limits: typeof builtinLimits;
  cacheTtlSeconds: number;
};

export function resolve(config: Config): Record<string, ResolvedDataset> {
  const out: Record<string, ResolvedDataset> = {};
  for (const [name, d] of Object.entries(config.datasets)) {
    out[name] = {
      ...d,
      limits: { ...builtinLimits, ...config.defaults.limits, ...d.limits },
      cacheTtlSeconds: d.cacheTtlSeconds ?? config.defaults.cacheTtlSeconds,
    };
  }
  return out;
}

export class ConfigError extends Error {}

export function loadConfig(file: string): Record<string, ResolvedDataset> {
  if (!fs.existsSync(file)) throw new ConfigError(`Configuration file not found: ${file}`);
  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`Cannot parse as YAML: ${file}\n  ${(e as Error).message}`);
  }
  const r = configSchema.safeParse(raw);
  const lines = r.success ? [] : r.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  // データセット名は、他の項目に誤りがあっても必ず確認する
  const names = Object.keys((raw as { datasets?: object } | null)?.datasets ?? {});
  for (const name of names) {
    const line = `  - datasets.${name}: Dataset names must start with a lowercase letter and contain only lowercase letters, digits, and _ (up to 64 characters)`;
    if (!NAME.test(name) && !lines.includes(line)) lines.unshift(line);
  }
  if (r.success && lines.length === 0) return resolve(r.data);
  // zod は型の誤りがあると superRefine（項目の組み合わせの確認）を実行しないため、その旨を添える
  const typeErrors = !r.success && r.error.issues.some((i) => i.code !== 'custom');
  const note = typeErrors ? '\n(After fixing type errors, more errors about combinations of settings may be shown)' : '';
  throw new ConfigError(`The configuration file has errors: ${file}\n${lines.join('\n')}${note}`);
}
