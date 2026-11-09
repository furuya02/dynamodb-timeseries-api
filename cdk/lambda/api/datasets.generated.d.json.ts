// cdk synth のときに生成される datasets.generated.json の型宣言
// （clone 直後はファイルがないため、tsc の型チェックはこの宣言を使う）
import type { ResolvedDataset } from '../../lib/config';

declare const datasets: Record<string, ResolvedDataset>;
export default datasets;
