// tools/og/og.html を描画して OGP 画像（public/og.png, 1200x630）とファビコン（public/favicon.png）を作る。
// 使い方: node tools/make-og.ts            → public に出力
//         node tools/make-og.ts --preview  → .cache/og-preview.png に出力して確認だけする
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preview = process.argv.includes('--preview');

const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1200, height: 630}});
await page.goto(pathToFileURL(path.join(root, 'tools', 'og', 'og.html')).href);
if (preview) {
  await page.screenshot({path: path.join(root, '.cache', 'og-preview.png')});
  console.log('.cache/og-preview.png written');
} else {
  await page.screenshot({path: path.join(root, 'public', 'og.png')});
  // ファビコンはマイクのアイコン部分だけを切り出す
  await page.locator('.mic').screenshot({path: path.join(root, 'public', 'favicon.png'), omitBackground: true});
  console.log('public/og.png, public/favicon.png written');
}
await browser.close();
