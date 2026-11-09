import * as fs from 'node:fs';
import * as path from 'node:path';

// lambda/api/datasets.generated.json は cdk synth で作られる（Git には含めない）。
// clone した直後でも Lambda の入口（index.ts など）を読み込めるよう、なければ空の設定を置く（テストでは vi.mock で差し替える）
export default function setup(): void {
  const file = path.join(__dirname, '../../lambda/api/datasets.generated.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '{}\n');
}
