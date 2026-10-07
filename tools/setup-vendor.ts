// sherpa-onnx の WASM ビルド（GitHub Releases）を取得して public/vendor に配置する。
//
// - ASR: vad-asr ビルドの glue から「焼き込み .data を読む loadPackage 呼び出し」を除去し、
//   モデルは実行時に HF から取得して MEMFS に書き込む方式にする。
//   silero_vad.onnx だけは .data から切り出して同梱する。
// - Denoise: speech-enhancement(GTCRN) ビルドはモデルが 0.5MB なので .data ごと同梱する。
//
// 使い方: node tools/setup-vendor.ts
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.cache');
const vendorDir = path.join(root, 'public', 'vendor');

const RELEASE_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
type Release = {tag: string; name: string};
type PackageEntry = {filename: string; start: number; end: number};

const ASR: Release = {
  tag: 'v1.13.2',
  name: 'sherpa-onnx-wasm-simd-1.13.2-vad-asr-ja-zipformer_reazonspeech',
};
const DENOISE: Release = {
  tag: 'v1.13.8',
  name: 'sherpa-onnx-wasm-simd-v1.13.8-speech-enhancement-gtcrn',
};
const COI_URL =
    'https://cdn.jsdelivr.net/npm/coi-serviceworker@0.1.7/coi-serviceworker.min.js';

async function download(url: string, dest: string): Promise<void> {
  if (fs.existsSync(dest)) {
    console.log(`cached: ${path.basename(dest)}`);
    return;
  }
  console.log(`download: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const tmp = dest + '.part';
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

async function fetchRelease({tag, name}: Release): Promise<string> {
  const tarball = path.join(cacheDir, `${name}.tar.bz2`);
  await download(`${RELEASE_BASE}/${tag}/${name}.tar.bz2`, tarball);
  const outDir = path.join(cacheDir, 'extract');
  const extracted = path.join(outDir, name);
  if (!fs.existsSync(extracted)) {
    fs.mkdirSync(outDir, {recursive: true});
    // GNU tar は "D:\..." をリモートホスト指定と解釈するので相対パスで渡す
    execFileSync('tar', ['-xjf', path.basename(tarball), '-C', 'extract'],
                 {cwd: cacheDir, stdio: 'inherit'});
  }
  return extracted;
}

function copy(srcDir: string, file: string, destDir: string, destName = file): void {
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, destName));
}

// glue 末尾付近の loadPackage({files:[...],remote_package_size:N}) を取り出す
function findPackageCall(glue: string): {call: string; files: PackageEntry[]} {
  const m = glue.match(/loadPackage\(\{files:(\[[^\]]*\]),remote_package_size:\d+\}\)/);
  if (!m || !m[1]) throw new Error('loadPackage call not found in glue');
  const files: PackageEntry[] = JSON.parse(m[1].replace(/(\w+):/g, '"$1":'));
  return {call: m[0], files};
}

async function setupAsr(): Promise<void> {
  const src = await fetchRelease(ASR);
  const dest = path.join(vendorDir, 'sherpa-asr');
  fs.mkdirSync(dest, {recursive: true});

  const glueName = 'sherpa-onnx-wasm-main-vad-asr.js';
  const glue = fs.readFileSync(path.join(src, glueName), 'utf8');
  const {call, files} = findPackageCall(glue);
  fs.writeFileSync(path.join(dest, glueName), glue.replace(call, 'void 0'));

  const vadEntry = files.find((f) => f.filename === '/silero_vad.onnx');
  if (!vadEntry) throw new Error('silero_vad.onnx not found in package');
  const fd = fs.openSync(path.join(src, 'sherpa-onnx-wasm-main-vad-asr.data'), 'r');
  const buf = Buffer.alloc(vadEntry.end - vadEntry.start);
  fs.readSync(fd, buf, 0, buf.length, vadEntry.start);
  fs.closeSync(fd);
  fs.writeFileSync(path.join(dest, 'silero_vad.onnx'), buf);

  for (const f of ['sherpa-onnx-wasm-main-vad-asr.wasm', 'sherpa-onnx-asr.js',
                   'sherpa-onnx-vad.js']) {
    copy(src, f, dest);
  }
  console.log(`asr vendor -> ${dest}`);
}

async function setupDenoise(): Promise<void> {
  const src = await fetchRelease(DENOISE);
  const dest = path.join(vendorDir, 'sherpa-denoise');
  fs.mkdirSync(dest, {recursive: true});
  for (const f of ['sherpa-onnx-wasm-main-speech-enhancement.js',
                   'sherpa-onnx-wasm-main-speech-enhancement.wasm',
                   'sherpa-onnx-wasm-main-speech-enhancement.data',
                   'sherpa-onnx-speech-enhancement.js']) {
    copy(src, f, dest);
  }
  console.log(`denoise vendor -> ${dest}`);
}

async function setupCoi(): Promise<void> {
  const dest = path.join(root, 'public', 'coi-serviceworker.js');
  const res = await fetch(COI_URL);
  if (!res.ok) throw new Error(`${res.status} ${COI_URL}`);
  fs.writeFileSync(dest, patchCoi(await res.text()));
  console.log(`coi-serviceworker -> ${dest}`);
}

// localhost 宛て（棒読みちゃん / VOICEVOX）は SW を通さない。
// SW が代理で fetch すると Chrome の Local Network Access の許可プロンプトが出せず失敗するため、
// respondWith せずにブラウザ既定の処理（ページ文脈のリクエスト）に任せる。
const COI_ANCHOR = 'if("only-if-cached"===r.cache&&"same-origin"!==r.mode)return;';
const COI_LOOPBACK_BYPASS =
    '{const u=new URL(r.url);if(u.origin!==self.location.origin&&/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(u.hostname))return}';

function patchCoi(src: string): string {
  if (src.includes(COI_LOOPBACK_BYPASS)) return src;
  if (!src.includes(COI_ANCHOR)) throw new Error('coi-serviceworker: patch anchor not found');
  return src.replace(COI_ANCHOR, COI_ANCHOR + COI_LOOPBACK_BYPASS);
}

fs.mkdirSync(cacheDir, {recursive: true});
await setupAsr();
await setupDenoise();
await setupCoi();
