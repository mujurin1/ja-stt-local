// 実ブラウザ（Chromium）での動作確認。
//   1) ファイル入力で文字起こし
//   2) 偽マイク（wav を流す）でリアルタイム認識し、partial / final が出るか
// 事前に `pnpm build && pnpm preview` で http://localhost:4173 を起動しておく。
// 使い方: node tools/e2e.ts [modelId] [clean|noisy] [--gtcrn] [--skip-file] [--skip-mic]
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [modelId = 'reazon-v2', fixture = 'clean'] = args.filter((a) => !a.startsWith('--'));
const wav = path.join(root, 'test', 'fixtures', `${fixture}.wav`);
const url = process.env.E2E_URL ?? 'http://localhost:4173/?debug';
// --kill-at=20: 録音開始 20 秒後に ASR worker を強制終了し、自動復帰を確認する
const killAt = Number(args.find((a) => a.startsWith('--kill-at='))?.split('=')[1] ?? 0);

const ctx = await chromium.launchPersistentContext(path.join(root, '.cache', 'pw-profile'), {
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = ctx.pages()[0] ?? await ctx.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || m.type() === 'warning' || t.startsWith('model ') || t.includes('VOICEVOX')) console.log(`[console.${m.type()}] ${t}`);
});
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

await page.addInitScript((s) => {
  localStorage.setItem('stt-settings-v1', JSON.stringify(s));
}, {
  modelId,
  gtcrn: flags.has('--gtcrn'),
  // 例: E2E_ASR='{"numThreads":1,"maxSpeechSec":8}'
  asr: JSON.parse(process.env.E2E_ASR ?? '{}') as object,
});

// 例: E2E_SEND='{"includeFile":true,"enabled":{"bouyomi":true},"configs":{"bouyomi":{"httpPort":50081}}}'
const sendSettings = process.env.E2E_SEND;
if (sendSettings) {
  await page.addInitScript((v) => localStorage.setItem('stt-send-v1', v), sendSettings);
}

await page.goto(url);
await page.waitForFunction(() => crossOriginIsolated, null, {timeout: 30000});
console.log('crossOriginIsolated: true');

const finals = () => page.$$eval('#finalList li', (lis) => lis.map((li) => li.textContent ?? ''));

if (!flags.has('--skip-file')) {
  const t0 = Date.now();
  await page.click('[data-tab=other]');
  await page.setInputFiles('#fileInput', wav);
  await page.waitForFunction(
      () => /完了|失敗/.test(document.querySelector('#fileText')?.textContent ?? ''), null,
      {timeout: 15 * 60 * 1000});
  console.log(`\n== file (${((Date.now() - t0) / 1000).toFixed(1)}s incl. model load)`);
  console.log(await page.textContent('#fileText'));
  console.log(`engine: ${await page.textContent('#engineState')}`);
  console.log((await finals()).join('\n'));
  if (process.env.E2E_SEND) {
    await page.waitForTimeout(3000);
    const log = await page.$$eval('.send-log li', (lis) => lis.map((li) => `  [${li.className}] ${li.textContent}`));
    console.log(`send log:\n${log.reverse().join('\n')}`);
  }
  await page.click('[data-tab=transcript]');
  await page.click('#clearBtn');
}

if (!flags.has('--skip-mic')) {
  await page.evaluate(() => {
    const w = window as unknown as {__partials: string[]};
    w.__partials = [];
    new MutationObserver(() => {
      const t = document.querySelector('#partialLine')?.textContent;
      if (t) w.__partials.push(t);
    }).observe(document.querySelector('#partialLine')!, {childList: true, characterData: true, subtree: true});
  });
  await page.click('#startBtn');
  await page.waitForFunction(() => document.querySelector('#startBtn')?.textContent?.includes('停止'), null,
                             {timeout: 15 * 60 * 1000});
  console.log('\n== mic: recording');
  // fixture は約 60 秒。最後の発話の確定まで待つ
  if (killAt > 0) {
    await page.waitForTimeout(killAt * 1000);
    await page.evaluate(() => {
      (window as unknown as {__stt: {asr: {worker: Worker}}}).__stt.asr.worker.terminate();
    });
    console.log(`killed asr worker at ${killAt}s`);
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1000);
      const s = await page.textContent('#engineState');
      if (i % 5 === 0 || !s?.includes('準備完了')) console.log(`  +${i + 1}s engine: ${s}`);
    }
    await page.waitForTimeout(Math.max(0, 64000 - killAt * 1000 - 25000));
  } else {
    await page.waitForTimeout(64000);
  }
  console.log(`capture: ${await page.textContent('#captureState')} / rtf=${await page.textContent('#statRtf')} queue=${await page.textContent('#statQueue')} decode=${await page.textContent('#statDecode')}`);
  await page.click('#startBtn');
  await page.waitForTimeout(1500);
  const partials = await page.evaluate(() => (window as unknown as {__partials: string[]}).__partials);
  console.log(`partial updates: ${partials.length}`);
  console.log(partials.slice(0, 8).map((p) => `  ~ ${p}`).join('\n'));
  console.log('finals:');
  console.log((await finals()).join('\n'));
  console.log(`engine: ${await page.textContent('#engineState')} restarts=${await page.textContent('#statRestarts')}`);
}

await ctx.close();
