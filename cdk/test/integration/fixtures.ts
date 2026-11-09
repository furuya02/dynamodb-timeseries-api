// ---------------------------------------------------------------
// 結合テストのテーブルとデータ（global-setup.ts が DynamoDB Local に作る）
// ---------------------------------------------------------------
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ResourceNotFoundException, type ScalarAttributeType } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** 2025-11-03 00:00 UTC */
export const T0 = Date.parse('2025-11-03T00:00:00Z');
export const H = 3_600_000;
/** 2025-11-03 00:00 JST */
export const J0 = T0 - 9 * H;

type Key = [string, ScalarAttributeType];
interface TableDef {
  name: string;
  pk: Key;
  sk: Key;
  gsi?: { name: string; pk: Key; sk: Key };
  items: Record<string, unknown>[];
}

const range = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

export const tables: TableDef[] = [
  {
    name: 't-epoch-ms',
    pk: ['deviceId', 'S'],
    sk: ['ts', 'N'],
    items: [
      // room-01 / room-02 を 1 時間おきに 48 件ずつ
      ...['room-01', 'room-02'].flatMap((d, j) => range(48, (i) => ({ deviceId: d, ts: T0 + i * H, temperature: 20 + j }))),
      // ページング: 約 1KB × 3000 件（1MB を超えるので複数ページになる）
      ...range(3000, (i) => ({ deviceId: 'big', ts: T0 + i * 1000, pad: 'x'.repeat(1000) })),
      // 応答サイズの上限: 約 1KB × 6000 件（約 6MB）
      ...range(6000, (i) => ({ deviceId: 'huge', ts: T0 + i * 1000, pad: 'y'.repeat(1000) })),
    ],
  },
  {
    name: 't-single',
    pk: ['pk', 'S'],
    sk: ['sk', 'S'],
    items: [
      // シングルテーブル設計: TEMP# と HUM# が同じ PK に混在
      ...['a', 'b'].flatMap((k) =>
        range(24, (i) => [
          { pk: `room#${k}`, sk: `TEMP#${new Date(T0 + i * H).toISOString()}`, temperature: i },
          { pk: `room#${k}`, sk: `HUM#${new Date(T0 + i * H).toISOString()}`, humidity: i },
        ]).flat(),
      ),
      // キー一覧用の登録用アイテム。BAD は pattern に合わない、d は id なし、e は a と重複
      { pk: 'devices', sk: 'a', id: 'a' },
      { pk: 'devices', sk: 'b', id: 'b' },
      { pk: 'devices', sk: 'c', id: 'BAD' },
      { pk: 'devices', sk: 'd', info: { code: 'x' } },
      { pk: 'devices', sk: 'e', id: 'a' },
    ],
  },
  {
    name: 't-iso-local',
    pk: ['deviceId', 'S'],
    sk: ['ts', 'S'],
    // オフセットなしの JST 文字列（ミリ秒あり・なしを混在）
    items: range(24, (i) => ({ deviceId: 'd1', ts: new Date(T0 + 9 * H + i * H).toISOString().slice(0, i % 2 ? 23 : 19), v: i })),
  },
  {
    name: 't-daily',
    pk: ['pk', 'S'],
    sk: ['ts', 'N'],
    // JST の日付で分けた PK、epoch 秒。2025-11-03 00:00 JST から 72 時間
    items: range(72, (i) => {
      const t = J0 + i * H;
      return { pk: `m1#${new Date(t + 9 * H).toISOString().slice(0, 10)}`, ts: t / 1000, watt: i };
    }),
  },
  {
    name: 't-transform',
    pk: ['deviceId', 'S'],
    sk: ['ts', 'N'],
    // 整数で保存した温度、文字列の数値、ネスト属性、真偽値の表現ゆれ、Set、予約語の属性名、機密属性
    items: [
      {
        deviceId: 'x',
        ts: T0,
        temperature: 215,
        humidity: '45.5',
        secret: 'pw',
        meta: { fw: '1.2.3', tags: ['a'] },
        on: 1,
        flag: 'TRUE',
        tags: new Set(['p', 'q']),
        count: 'abc',
        date: '2025-11-03',
      },
      { deviceId: 'x', ts: T0 + H, temperature: 3, on: false, flag: 'no', count: 7 },
    ],
  },
  {
    name: 't-agg',
    pk: ['deviceId', 'S'],
    sk: ['ts', 'N'],
    items: [
      // a: 10 分おき（value = 0..143、i = 3 だけ value なし）/ b: 30 分おき（value = 100..147）
      ...range(144, (i) => ({ deviceId: 'a', ts: T0 + i * 600_000, ...(i === 3 ? {} : { value: i }), label: `a${i}` })),
      ...range(48, (i) => ({ deviceId: 'b', ts: T0 + i * 1_800_000, value: 100 + i, label: `b${i}` })),
    ],
  },
  {
    name: 't-gsi',
    pk: ['id', 'S'],
    sk: ['ts', 'N'],
    gsi: { name: 'byRoom', pk: ['room', 'S'], sk: ['ts', 'N'] },
    items: range(10, (i) => ({ id: `x${i}`, room: i < 6 ? 'r1' : 'r2', ts: T0 + i * H, v: i })),
  },
];

/** テーブルを作り直してデータを入れる（同じ DynamoDB Local で何度でも実行できるように） */
export async function seed(endpoint: string): Promise<void> {
  const raw = new DynamoDBClient({ endpoint, region: 'ap-northeast-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  const doc = DynamoDBDocumentClient.from(raw);
  for (const t of tables) {
    await raw.send(new DeleteTableCommand({ TableName: t.name })).catch((e) => {
      if (!(e instanceof ResourceNotFoundException)) throw e;
    });
    const defs = new Map([t.pk, t.sk, ...(t.gsi ? [t.gsi.pk, t.gsi.sk] : [])]);
    await raw.send(
      new CreateTableCommand({
        TableName: t.name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [...defs].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })),
        KeySchema: [
          { AttributeName: t.pk[0], KeyType: 'HASH' },
          { AttributeName: t.sk[0], KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: t.gsi && [
          {
            IndexName: t.gsi.name,
            KeySchema: [
              { AttributeName: t.gsi.pk[0], KeyType: 'HASH' },
              { AttributeName: t.gsi.sk[0], KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
    for (let i = 0; i < t.items.length; i += 25) {
      await doc.send(new BatchWriteCommand({ RequestItems: { [t.name]: t.items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }));
    }
  }
  raw.destroy();
}
