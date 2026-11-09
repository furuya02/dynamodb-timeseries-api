// ---------------------------------------------------------------
// デプロイしたスタックの出力（CloudFormation）
// ---------------------------------------------------------------
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const DEFAULT_STACK = 'DynamodbTimeseriesApiStack';

/** スタックの出力（Endpoint、Region、GetApiKeyCommand など） */
export type StackOutputs = Record<string, string | undefined>;

export async function getStackOutputs(stackName: string, region: string): Promise<StackOutputs> {
  const stack = (await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
  const outputs = Object.fromEntries((stack?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue]));
  if (!outputs.Endpoint) throw new Error(`スタック ${stackName} の出力に Endpoint がありません（リージョン ${region}）`);
  return outputs;
}

/** GetApiKeyCommand の出力から API キーの ID を取り出す（API キー認証のスタックだけにある） */
export const apiKeyIdOf = (outputs: StackOutputs): string | undefined => outputs.GetApiKeyCommand?.match(/--api-key (\S+)/)?.[1];
