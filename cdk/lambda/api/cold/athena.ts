// ---------------------------------------------------------------
// Athena の実行（開始 → 完了まで待つ → 結果をページングで読む）
// API Gateway の 29 秒の上限より前に打ち切り、クエリを止めて理由つきのエラーにする
// ---------------------------------------------------------------
import {
  type AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { ApiError } from '../errors';

/** 1 行 = 列名 → 値（Athena は値を文字列で返す。NULL は undefined） */
export type AthenaRow = Record<string, string | undefined>;

export interface AthenaResult {
  rows: AthenaRow[];
  /** 読んだデータ量（課金の単位） */
  bytesScanned: number;
  /** Athena での実行時間 */
  engineMs: number;
}

/** SQL を実行するもの（テストでは差し替える） */
export interface AthenaRunner {
  /** params は SQL の ? に順に入る（文字列は引用符を含めて渡す） */
  run(sql: string, params: string[]): Promise<AthenaResult>;
}

export interface AthenaRunnerOptions {
  workgroup: string;
  database: string;
  /** 完了を待つ上限（ミリ秒） */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createAthenaRunner(client: Pick<AthenaClient, 'send'>, o: AthenaRunnerOptions): AthenaRunner {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  return {
    async run(sql, params) {
      const started = now();
      const { QueryExecutionId: id } = await client.send(
        new StartQueryExecutionCommand({
          QueryString: sql,
          ExecutionParameters: params.length > 0 ? params : undefined,
          WorkGroup: o.workgroup,
          QueryExecutionContext: { Database: o.database },
        }),
      );
      // 短いクエリは 1 秒未満で終わるため、最初は短い間隔で確かめ、徐々に延ばす
      for (let wait = 200; ; wait = Math.min(wait * 2, 1000)) {
        const { QueryExecution: q } = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
        const state = q?.Status?.State;
        if (state === 'SUCCEEDED') {
          const rows = await readResults(client, id as string);
          return { rows, bytesScanned: q?.Statistics?.DataScannedInBytes ?? 0, engineMs: q?.Statistics?.EngineExecutionTimeInMillis ?? 0 };
        }
        if (state === 'FAILED' || state === 'CANCELLED') {
          const reason = q?.Status?.StateChangeReason ?? state;
          // ワークグループの読み込み量の上限（BytesScannedCutoffPerQuery）に当たった場合も、ここで理由を返す
          throw new ApiError(502, `The cold storage (Athena) query failed: ${reason}`);
        }
        if (now() - started + wait > timeoutMs) {
          await client.send(new StopQueryExecutionCommand({ QueryExecutionId: id }));
          throw new ApiError(
            504,
            `The cold storage (Athena) query did not finish within ${timeoutMs / 1000} seconds. Shorten the time range or use a larger interval`,
          );
        }
        await sleep(wait);
      }
    },
  };
}

async function readResults(client: Pick<AthenaClient, 'send'>, id: string): Promise<AthenaRow[]> {
  const out: AthenaRow[] = [];
  let header: string[] | undefined;
  let token: string | undefined;
  do {
    const r = await client.send(new GetQueryResultsCommand({ QueryExecutionId: id, NextToken: token }));
    for (const row of r.ResultSet?.Rows ?? []) {
      const cells = (row.Data ?? []).map((d) => d.VarCharValue);
      // 1 ページ目の先頭の行は列名
      if (!header) header = cells.map((c) => c ?? '');
      else out.push(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
    }
    token = r.NextToken;
  } while (token);
  return out;
}
