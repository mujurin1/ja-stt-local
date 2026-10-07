// VAD + オフライン認識器で擬似ストリーミング認識を行う worker。
//
// - 発話中は「発話開始から現在まで」を一定間隔で再認識して partial を出す
//   （キューが詰まっている時はスキップするので低スペックでも遅延が蓄積しない）
// - VAD が発話区間を確定したら、その区間で final を出す
// - 時刻は init からの累積サンプル数基準（flush / 設定変更を挟んでも連続する）
import {modelFileUrl} from '../shared/models.ts';
import {SAMPLE_RATE} from '../shared/protocol.ts';
import type {
  AsrEvent, AsrRequest, AsrSettings, ModelFile, ModelFileRole, ModelSpec,
} from '../shared/protocol.ts';
import {fetchCached} from '../shared/model-cache.ts';
import {errorMessage, loadRuntime, syncHeap} from './runtime.ts';

const VAD_WINDOW = 512;
const RING_SECONDS = 60;
// 音声が届いてから処理するまでの遅れがこれを超えたら partial を諦めて追いつきを優先する
const MAX_QUEUE_MS_FOR_PARTIAL = 800;
const DECODE_PAD_SEC = 0.5;
const PRE_ROLL_SEC = 0.3;

class SampleRing {
  buf: Float32Array;
  total = 0;

  constructor(capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  push(x: Float32Array): void {
    const cap = this.buf.length;
    let src = x.length > cap ? x.subarray(x.length - cap) : x;
    let pos = (this.total + (x.length - src.length)) % cap;
    while (src.length > 0) {
      const n = Math.min(src.length, cap - pos);
      this.buf.set(src.subarray(0, n), pos);
      src = src.subarray(n);
      pos = (pos + n) % cap;
    }
    this.total += x.length;
  }

  // [from, to) を返す。古すぎて残っていない部分は切り詰める。
  slice(from: number, to: number): Float32Array {
    const cap = this.buf.length;
    const start = Math.max(from, to - cap, this.total - cap, 0);
    const out = new Float32Array(Math.max(0, to - start));
    let pos = start % cap;
    let written = 0;
    while (written < out.length) {
      const n = Math.min(out.length - written, cap - pos);
      out.set(this.buf.subarray(pos, pos + n), written);
      written += n;
      pos = (pos + n) % cap;
    }
    return out;
  }

  reset(): void {
    this.total = 0;
  }
}

let mod: SherpaModule | null = null;
let recognizer: OfflineRecognizer | null = null;
let vad: Vad | null = null;
let settings: AsrSettings;
let modelSpec: ModelSpec | null = null;
let consecutiveDecodeErrors = 0;

const ring = new SampleRing(SAMPLE_RATE * RING_SECONDS);
const vadPending = new Float32Array(VAD_WINDOW);
let vadPendingLen = 0;
// 現在の VAD インスタンスに入れたサンプル数（VAD の segment.start と同じ基準）
let processed = 0;
// 過去の VAD インスタンスで処理済みのサンプル数（出力時刻の連続性のため）
let timeBase = 0;

let inSpeech = false;
let speechStart = 0;
let lastPartialAt = 0;
let lastPartialText = '';
let lastPartialCostMs = 0;

let lastDecodeMs = 0;
let decodedAudioSec = 0;
let decodeWallMs = 0;
let lastQueueMs = 0;

const queue: {samples: Float32Array; sentAt: number}[] = [];
let scheduled = false;
let fileJobRunning = false;

function post(ev: AsrEvent): void {
  postMessage(ev);
}

function toSec(index: number): number {
  return (timeBase + index) / SAMPLE_RATE;
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i) : '';
}

function buildRecognizerConfig(
    spec: ModelSpec, p: Partial<Record<ModelFileRole, string>>,
    numThreads: number): object {
  const modelConfig: Record<string, unknown> = {
    tokens: p.tokens,
    numThreads,
    provider: 'cpu',
    debug: 0,
  };
  switch (spec.kind) {
    case 'transducer':
      modelConfig.transducer = {encoder: p.encoder, decoder: p.decoder, joiner: p.joiner};
      modelConfig.modelType = 'transducer';
      break;
    case 'senseVoice':
      modelConfig.senseVoice = {model: p.model, language: 'ja', useInverseTextNormalization: 1};
      break;
    case 'nemoCtc':
      modelConfig.nemoCtc = {model: p.model};
      break;
    case 'moonshine':
      modelConfig.moonshine = {encoder: p.encoder, mergedDecoder: p.mergedDecoder};
      break;
  }
  return {
    featConfig: {sampleRate: SAMPLE_RATE, featureDim: 80},
    modelConfig,
    decodingMethod: 'greedy_search',
  };
}

function createVadInstance(m: SherpaModule): Vad {
  const vadModel = (windowSize: number, model: string) => ({
    model,
    threshold: settings.vadThreshold,
    minSilenceDuration: settings.minSilenceSec,
    minSpeechDuration: settings.minSpeechSec,
    maxSpeechDuration: Math.min(settings.maxSpeechSec, modelSpec?.maxSegmentSec ?? Infinity),
    windowSize,
  });
  return createVad(m, {
    sileroVad: vadModel(VAD_WINDOW, '/silero_vad.onnx'),
    tenVad: vadModel(256, ''),
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: Math.ceil(settings.maxSpeechSec) + 10,
  });
}

async function init(req: Extract<AsrRequest, {type: 'init'}>): Promise<void> {
  const t0 = performance.now();
  settings = req.settings;
  const spec = req.model;
  modelSpec = spec;
  const base = req.vendorBase + 'sherpa-asr/';

  post({type: 'status', message: 'ランタイムを読み込み中…'});
  const m = await loadRuntime({
    base,
    scripts: ['sherpa-onnx-asr.js', 'sherpa-onnx-vad.js'],
    glue: 'sherpa-onnx-wasm-main-vad-asr.js',
    sharedMemoryPages: 8192,
    onAbort: (message) => post({type: 'error', message, fatal: true}),
  });
  mod = m;

  const vadRes = await fetch(base + 'silero_vad.onnx');
  if (!vadRes.ok) throw new Error(`silero_vad.onnx: ${vadRes.status}`);
  m.FS_createDataFile('/', 'silero_vad.onnx', new Uint8Array(await vadRes.arrayBuffer()),
                      true, false, true);

  const entries = Object.entries(spec.files) as [ModelFileRole, ModelFile][];
  const totalBytes = entries.reduce((s, [, f]) => s + f.bytes, 0);
  let doneBytes = 0;
  const paths: Partial<Record<ModelFileRole, string>> = {};
  for (const [role, file] of entries) {
    const data = await fetchCached(
        modelFileUrl(spec, file.path), file.bytes,
        (loaded) => post({
          type: 'progress',
          label: spec.label,
          loaded: doneBytes + loaded,
          total: totalBytes,
        }));
    doneBytes += file.bytes;
    const name = role + extOf(file.path);
    m.FS_createDataFile('/', name, data, true, false, true);
    paths[role] = '/' + name;
  }

  post({type: 'status', message: 'モデルを初期化中…'});
  syncHeap(m);
  const r = new OfflineRecognizer(
      buildRecognizerConfig(spec, paths, settings.numThreads), m);
  // セッション作成後はファイルの中身は不要。MEMFS 上のコピーを解放する。
  for (const p of Object.values(paths)) m.FS_unlink(p);
  if (!r.handle) throw new Error('認識器の作成に失敗しました（メモリ不足の可能性があります）');
  recognizer = r;

  resetVad();
  post({
    type: 'ready',
    modelId: spec.id,
    loadMs: performance.now() - t0,
    numThreads: settings.numThreads,
  });
  setInterval(postStats, 1000);
}

function resetVad(): void {
  if (!mod) return;
  timeBase += processed + vadPendingLen;
  vad?.free();
  vad = createVadInstance(mod);
  processed = 0;
  vadPendingLen = 0;
  ring.reset();
  inSpeech = false;
  lastPartialText = '';
}

// SenseVoice 等は日本語でも単語間に空白を入れて返すので、日本語に隣接する空白を詰める
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/ (?=[^\x00-\x7F])|(?<=[^\x00-\x7F]) /g, '');
}

function decode(samples: Float32Array): string {
  if (!mod || !recognizer) return '';
  syncHeap(mod);
  // 発話が無音なしで始まる／終わると、モデルが語頭・語尾を落とすことがある（実測で文の前半が丸ごと
  // 欠けた）。前後に無音を足してから認識する。
  const pad = Math.round(DECODE_PAD_SEC * SAMPLE_RATE);
  const padded = new Float32Array(samples.length + pad * 2);
  padded.set(samples, pad);
  const t0 = performance.now();
  const stream = recognizer.createStream();
  try {
    stream.acceptWaveform(SAMPLE_RATE, padded);
    recognizer.decode(stream);
    const text = normalizeText(recognizer.getResult(stream).text);
    consecutiveDecodeErrors = 0;
    return text;
  } catch (e) {
    // C++ 例外は数値（ポインタ）で飛んでくる。1 区間の失敗で止めず、続くようなら worker ごと作り直す
    consecutiveDecodeErrors++;
    post({
      type: 'error',
      message: `認識エラー（${(samples.length / SAMPLE_RATE).toFixed(1)}秒の区間）: ${errorMessage(e)}`,
      fatal: consecutiveDecodeErrors >= 3,
    });
    return '';
  } finally {
    stream.free();
    lastDecodeMs = performance.now() - t0;
    decodeWallMs += lastDecodeMs;
    decodedAudioSec += samples.length / SAMPLE_RATE;
  }
}

// VAD の検出は語頭より少し遅れるので、区間の少し前から切り出して認識する
function withPreRoll(start: number, end: number): Float32Array {
  return ring.slice(Math.max(0, start - Math.round(PRE_ROLL_SEC * SAMPLE_RATE)), end);
}

function emitFinal(start: number, samples: Float32Array): void {
  const audio = ring.total >= start + samples.length ?
      withPreRoll(start, start + samples.length) :
      samples;
  const text = decode(audio);
  post({
    type: 'final',
    segment: {start: toSec(start), end: toSec(start + samples.length), text},
    decodeMs: lastDecodeMs,
  });
  lastPartialText = '';
}

function drainSegments(v: Vad): void {
  while (!v.isEmpty()) {
    const seg = v.front();
    v.pop();
    emitFinal(seg.start, seg.samples);
    // maxSpeechDuration で強制分割された場合は発話が続いている
    if (v.isDetected()) {
      speechStart = seg.start + seg.samples.length;
      lastPartialAt = processed;
    }
  }
}

function feed(samples: Float32Array): void {
  const v = vad;
  if (!mod || !v) return;
  syncHeap(mod);
  ring.push(samples);
  let i = 0;
  while (i < samples.length) {
    const n = Math.min(VAD_WINDOW - vadPendingLen, samples.length - i);
    vadPending.set(samples.subarray(i, i + n), vadPendingLen);
    vadPendingLen += n;
    i += n;
    if (vadPendingLen < VAD_WINDOW) break;

    v.acceptWaveform(vadPending);
    processed += VAD_WINDOW;
    vadPendingLen = 0;

    const detected = v.isDetected();
    if (detected && !inSpeech) {
      inSpeech = true;
      // sherpa の silero VAD と同じ式で発話開始位置を見積もる
      speechStart = Math.max(
          0, processed - Math.round(settings.minSpeechSec * SAMPLE_RATE) - 2 * VAD_WINDOW);
      lastPartialAt = processed;
    }
    drainSegments(v);
    if (!detected) inSpeech = false;
  }
}

function maybePartial(): void {
  if (!inSpeech || lastQueueMs > MAX_QUEUE_MS_FOR_PARTIAL) return;
  const interval = Math.max(settings.partialIntervalMs, lastPartialCostMs * 1.5);
  if ((processed - lastPartialAt) * 1000 / SAMPLE_RATE < interval) return;
  lastPartialAt = processed;
  const text = decode(withPreRoll(speechStart, ring.total));
  lastPartialCostMs = lastDecodeMs;
  if (text !== lastPartialText) {
    lastPartialText = text;
    post({type: 'partial', start: toSec(speechStart), text});
  }
}

function processQueue(): void {
  scheduled = false;
  if (!recognizer || !vad || fileJobRunning) return;
  try {
    let sentAt = Date.now();
    while (queue.length > 0) {
      const chunk = queue.shift()!;
      sentAt = chunk.sentAt;
      feed(chunk.samples);
    }
    lastQueueMs = Date.now() - sentAt;
    maybePartial();
  } catch (e) {
    post({type: 'error', message: errorMessage(e), fatal: true});
  }
}

function flushLive(): void {
  processQueue();
  const v = vad;
  if (v) {
    v.flush();
    drainSegments(v);
  }
  post({type: 'partial', start: 0, text: ''});
  resetVad();
}

function runFile(req: Extract<AsrRequest, {type: 'file'}>): void {
  const v0 = vad;
  if (!v0) throw new Error('モデルが未初期化です');
  fileJobRunning = true;
  const t0 = performance.now();
  const savedBase = timeBase + processed + vadPendingLen;
  resetVad();
  timeBase = 0;
  try {
    const total = req.samples.length;
    const step = SAMPLE_RATE;
    let lastReport = 0;
    for (let off = 0; off < total; off += step) {
      feed(req.samples.subarray(off, off + step));
      const now = performance.now();
      if (now - lastReport > 300) {
        lastReport = now;
        post({
          type: 'file-progress',
          jobId: req.jobId,
          doneSec: off / SAMPLE_RATE,
          totalSec: total / SAMPLE_RATE,
        });
      }
    }
    const v = vad;
    if (v) {
      v.flush();
      drainSegments(v);
    }
    post({type: 'file-done', jobId: req.jobId, elapsedMs: performance.now() - t0});
  } finally {
    resetVad();
    timeBase = savedBase;
    fileJobRunning = false;
  }
}

function postStats(): void {
  post({
    type: 'stats',
    processedSec: toSec(processed + vadPendingLen),
    speech: inSpeech,
    queueMs: lastQueueMs,
    lastDecodeMs,
    rtf: decodedAudioSec > 0 ? decodeWallMs / 1000 / decodedAudioSec : 0,
  });
}

addEventListener('message', (e: MessageEvent<AsrRequest>) => {
  const req = e.data;
  try {
    switch (req.type) {
      case 'init':
        init(req).catch((err: unknown) =>
          post({type: 'error', message: errorMessage(err), fatal: true}));
        break;
      case 'audio':
        queue.push(req);
        if (!scheduled) {
          scheduled = true;
          setTimeout(processQueue, 0);
        }
        break;
      case 'settings':
        settings = req.settings;
        // VAD のしきい値等は作り直さないと反映されない。進行中の発話は確定させてから切り替える。
        if (vad) flushLive();
        break;
      case 'flush':
        flushLive();
        post({type: 'flushed'});
        break;
      case 'file':
        runFile(req);
        break;
    }
  } catch (err) {
    post({type: 'error', message: errorMessage(err), fatal: true});
  }
});
