import { QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { QueryClient } from '../../lambda/api/reader';
import { configSchema, type ResolvedDataset, resolve } from '../../lib/config';

/** datasets.yaml と同じ形のオブジェクトから、検証・既定値の反映を済ませたデータセットを作る */
export function dataset(raw: Record<string, unknown>, name = 'ds'): ResolvedDataset {
  return resolve(configSchema.parse({ datasets: { [name]: raw } }))[name];
}

/** 最小のデータセット（epoch_ms、キーは values: [a, b]、列は value） */
export const base = (overrides: Record<string, unknown> = {}): ResolvedDataset =>
  dataset({
    table: 'tbl',
    partitionKey: { name: 'pk' },
    sortKey: { name: 'ts', format: 'epoch_ms' },
    keys: { values: ['a', 'b'] },
    fields: [{ name: 'value' }],
    ...overrides,
  });

/** 送られた Query を記録し、用意した応答を順に返す偽のクライアント */
export function fakeClient(respond: (input: QueryCommand['input'], call: number) => Partial<QueryCommandOutput>) {
  const calls: QueryCommand['input'][] = [];
  const client: QueryClient = {
    async send(command) {
      if (!(command instanceof QueryCommand)) throw new Error('A command other than QueryCommand was sent');
      calls.push(command.input);
      return { $metadata: {}, ...respond(command.input, calls.length - 1) };
    },
  };
  return { client, calls };
}
