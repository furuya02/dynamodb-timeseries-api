import { seed } from './fixtures';

// 結合テストの前に 1 回だけ、DynamoDB Local にテーブルとデータを作る
export default async function setup(): Promise<void> {
  const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB ?? 'http://localhost:8000';
  try {
    await fetch(endpoint);
  } catch {
    throw new Error(
      `DynamoDB Local（${endpoint}）に接続できません。\n` +
        '  docker run -d --rm -p 8000:8000 amazon/dynamodb-local:3.3.2 -jar DynamoDBLocal.jar -inMemory\n' +
        'で起動するか、AWS_ENDPOINT_URL_DYNAMODB で接続先を指定してください',
    );
  }
  await seed(endpoint);
}
