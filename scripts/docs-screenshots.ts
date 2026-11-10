// ---------------------------------------------------------------
// 手順書のスクリーンショットを撮り直す（ライト / ダークの両方）
//   pnpm grafana-config && pnpm grafana-up   … 先にローカルの Grafana を起動しておく
//   pnpm docs-screenshots                    … docs/images/<名前>-light.png / -dark.png を書き出す
//   pnpm docs-screenshots --cold             … コールドストア（37 日表示）の画面も撮る（-c cold=true と pnpm seed --cold-days 30 が必要）
// 初回だけ、ブラウザを入れる: pnpm --dir scripts exec playwright install chromium
// ---------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { type Browser, chromium, type Page } from 'playwright';
import { DATASOURCE_UID } from './lib/grafana.ts';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    user: { type: 'string', default: 'admin' },
    password: { type: 'string', default: 'admin' },
    out: { type: 'string', default: path.join(import.meta.dirname, '../docs/images') },
    cold: { type: 'boolean', default: false },
    only: { type: 'string' }, // 名前を指定するとそれだけ撮る（カンマ区切り）
  },
});

const DASHBOARD = '/d/tsapi-room-temp/';
const ALERT_RULE = 'tsapi-room-temp-high';
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

interface Shot {
  name: string;
  path: string;
  /** 撮る前の操作（開く・展開するなど） */
  prepare?: (page: Page) => Promise<void>;
  /** 画面の一部だけを撮るときの要素 */
  clip?: string;
  /** 画面の高さ（既定 900） */
  height?: number;
  cold?: boolean;
}

const shots: Shot[] = [
  { name: 'dashboard', path: `${DASHBOARD}?orgId=1&from=now-7d&to=now&kiosk`, height: 1100 },
  { name: 'datasource', path: `/connections/datasources/edit/${DATASOURCE_UID}` },
  {
    name: 'query-editor',
    path: `${DASHBOARD}?orgId=1&from=now-24h&to=now&editPanel=1`,
    height: 1650,
    prepare: async (page) => {
      await page.getByText('Headers, Request params').first().click();
    },
  },
  {
    name: 'parsing-options',
    path: `${DASHBOARD}?orgId=1&from=now-24h&to=now&editPanel=1`,
    height: 1500,
    prepare: async (page) => {
      await page.getByText('Parsing options & Result fields', { exact: false }).first().click();
    },
  },
  {
    name: 'variable',
    path: `${DASHBOARD}?orgId=1&editview=variables`,
    height: 1300,
    prepare: async (page) => {
      // Grafana 13 では変数の設定がダッシュボードのサイドバーに移った
      await page.getByText('Take me there').click();
      await page.waitForTimeout(1500);
      // 編集ボタンはマウスを重ねたときだけ表示されるため、force で押す
      await page.locator('[data-testid^="data-testid element-edit edit button"]').first().click({ force: true });
      await page.getByRole('button', { name: 'Open variable editor' }).click();
      await page.getByText('Headers, Request params').last().click();
    },
  },
  { name: 'alert-rule', path: `/alerting/grafana/${ALERT_RULE}/view`, height: 1300 },
  { name: 'meta', path: `${DASHBOARD}?orgId=1&from=now-24h&to=now&viewPanel=6&kiosk`, height: 300 },
  { name: 'cold-37-days', path: `${DASHBOARD}?orgId=1&from=now-37d&to=now&viewPanel=1&kiosk`, height: 640, cold: true },
  { name: 'cold-meta', path: `${DASHBOARD}?orgId=1&from=now-37d&to=now&viewPanel=6&kiosk`, height: 300, cold: true },
];

async function setTheme(page: Page, theme: Theme): Promise<void> {
  const r = await page.request.put(`${args.url}/api/user/preferences`, { data: { theme } });
  if (!r.ok()) throw new Error(`Could not change the theme: ${r.status()} ${await r.text()}`);
}

async function capture(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  // 左のメニューを閉じた状態で撮る
  await context.addInitScript("localStorage.setItem('grafana.navigation.docked', 'false')");
  const page = await context.newPage();
  const login = await page.request.post(`${args.url}/login`, { data: { user: args.user, password: args.password } });
  if (!login.ok()) throw new Error(`Could not log in to Grafana (${args.url}): ${login.status()}`);
  const only = args.only?.split(',');
  const targets = shots.filter((s) => (s.cold ? args.cold : true) && (!only || only.includes(s.name)));
  fs.mkdirSync(args.out, { recursive: true });
  for (const theme of THEMES) {
    await setTheme(page, theme);
    for (const s of targets) {
      await page.setViewportSize({ width: 1440, height: s.height ?? 900 });
      await page.goto(`${args.url}${s.path}`, { waitUntil: 'networkidle' });
      await s.prepare?.(page);
      // パネルの描画（アニメーション）が終わるのを待つ
      await page.waitForTimeout(2500);
      const file = path.join(args.out, `${s.name}-${theme}.png`);
      if (s.clip) await page.locator(s.clip).screenshot({ path: file });
      else await page.screenshot({ path: file });
      console.log(`  ${path.relative(process.cwd(), file)}`);
    }
  }
  await page.request.put(`${args.url}/api/user/preferences`, { data: { theme: '' } }); // Grafana の既定に戻す
  await context.close();
}

const browser = await chromium.launch();
try {
  await capture(browser);
} finally {
  await browser.close();
}
