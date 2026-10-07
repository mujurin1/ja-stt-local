// tools/og/og.html を描画して OGP 画像（public/og.png, 1200x630）とファビコン（public/favicon.png）を作る。
// 使い方: node tools/make-og.ts            → public に出力
//         node tools/make-og.ts --preview  → .cache/og-preview.png, .cache/favicon-preview.png に出力して確認だけする
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preview = process.argv.includes('--preview');
const outDir = path.join(root, preview ? '.cache' : 'public');
const ogPath = path.join(outDir, preview ? 'og-preview.png' : 'og.png');
const faviconPath = path.join(outDir, preview ? 'favicon-preview.png' : 'favicon.png');

const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1200, height: 630}});
await page.goto(pathToFileURL(path.join(root, 'tools', 'og', 'og.html')).href);
await page.screenshot({path: ogPath});
// ファビコンはアイコンだけを表示する状態に切り替えてから切り出す
await page.evaluate(() => document.body.classList.add('favicon'));
await page.locator('.mic').screenshot({path: faviconPath, omitBackground: true});
console.log(`${path.relative(root, ogPath)}, ${path.relative(root, faviconPath)} written`);
await browser.close();
