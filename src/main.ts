import {MicCapture} from './audio/capture.ts';
import type {CaptureOptions, CaptureState} from './audio/capture.ts';
import {decodeFileTo16k} from './audio/file-decode.ts';
import {AsrClient} from './engine/asr-client.ts';
import type {AsrState} from './engine/asr-client.ts';
import {DenoiseClient} from './engine/denoise-client.ts';
import type {DenoiseState} from './engine/denoise-client.ts';
import {NativeAsr} from './engine/native-asr.ts';
import {hasSavedSettings, loadSettings, saveSettings} from './settings.ts';
import type {AppSettings} from './settings.ts';
import {ModelPanel} from './model-panel.ts';
import {SendPanel} from './send/panel.ts';
import {SEND_TARGETS} from './send/targets.ts';
import {modelCacheStatus} from './shared/model-cache.ts';
import {FALLBACK_MODEL_ID, MODEL_CACHE_NAME, MODELS, modelTotalBytes} from './shared/models.ts';
import {SAMPLE_RATE} from './shared/protocol.ts';
import type {AsrEvent, AsrSettings, ModelSpec, Segment} from './shared/protocol.ts';
import {download, formatClock, toJson, toSrt, toTxt, toVtt} from './transcript.ts';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

const ui = {
  engineState: $<HTMLSpanElement>('engineState'),
  isolationWarning: $<HTMLDivElement>('isolationWarning'),
  modelList: $<HTMLUListElement>('modelList'),
  modelDetail: $<HTMLDivElement>('modelDetail'),
  currentModelName: $<HTMLSpanElement>('currentModelName'),
  loadProgress: $<HTMLDivElement>('loadProgress'),
  loadBar: $<HTMLDivElement>('loadBar'),
  loadText: $<HTMLSpanElement>('loadText'),
  nativeMicNote: $<HTMLParagraphElement>('nativeMicNote'),
  deviceSelect: $<HTMLSelectElement>('deviceSelect'),
  startBtn: $<HTMLButtonElement>('startBtn'),
  levelBar: $<HTMLDivElement>('levelBar'),
  captureState: $<HTMLSpanElement>('captureState'),
  optNs: $<HTMLInputElement>('optNs'),
  optEc: $<HTMLInputElement>('optEc'),
  optAgc: $<HTMLInputElement>('optAgc'),
  optGtcrn: $<HTMLInputElement>('optGtcrn'),
  gtcrnState: $<HTMLSpanElement>('gtcrnState'),
  fileInput: $<HTMLInputElement>('fileInput'),
  fileProgress: $<HTMLDivElement>('fileProgress'),
  fileBar: $<HTMLDivElement>('fileBar'),
  fileText: $<HTMLSpanElement>('fileText'),
  statRtf: $<HTMLElement>('statRtf'),
  statQueue: $<HTMLElement>('statQueue'),
  statDecode: $<HTMLElement>('statDecode'),
  statRestarts: $<HTMLElement>('statRestarts'),
  clearCacheBtn: $<HTMLButtonElement>('clearCacheBtn'),
  storageInfo: $<HTMLSpanElement>('storageInfo'),
  optTimestamps: $<HTMLInputElement>('optTimestamps'),
  copyBtn: $<HTMLButtonElement>('copyBtn'),
  clearBtn: $<HTMLButtonElement>('clearBtn'),
  transcript: $<HTMLDivElement>('transcript'),
  finalList: $<HTMLOListElement>('finalList'),
  partialLine: $<HTMLParagraphElement>('partialLine'),
  licenseInfo: $<HTMLSpanElement>('licenseInfo'),
};

const settings: AppSettings = loadSettings();
const segments: Segment[] = [];
const vendorBase = new URL('./vendor/', location.href).href;

let asrState: AsrState | 'idle' = 'idle';
let readyWaiters: {resolve: () => void; reject: (e: Error) => void}[] = [];
let recording = false;
// 録音中のものがブラウザ標準の音声認識か（録音中にモデルを切り替えても正しく止めるため）
let recordingNative = false;
let startPending = false;
let fileBusy = false;
let exportBaseName = '';
let wakeLock: WakeLockSentinel | null = null;

function currentModel(): ModelSpec {
  return MODELS.find((m) => m.id === settings.modelId) ?? MODELS[0]!;
}

// ブラウザ標準の音声認識は worker・マイク取り込みを使わず NativeAsr だけで動く
function isNative(): boolean {
  return currentModel().kind === 'native';
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

function setPill(text: string, kind: '' | 'ok' | 'busy' | 'error'): void {
  ui.engineState.textContent = text;
  ui.engineState.className = `pill ${kind}`;
}

function captureOptions(): CaptureOptions {
  return {
    deviceId: settings.deviceId,
    noiseSuppression: settings.browserNoiseSuppression,
    echoCancellation: settings.browserEchoCancellation,
    autoGainControl: settings.browserAutoGain,
  };
}

// ---- 文字起こし表示 ----

function isNearBottom(): boolean {
  const t = ui.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
}

function scrollToBottomIf(stick: boolean): void {
  if (stick) ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function appendSegment(seg: Segment): void {
  const stick = isNearBottom();
  segments.push(seg);
  const li = document.createElement('li');
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = formatClock(seg.start);
  li.append(ts, document.createTextNode(seg.text));
  ui.finalList.append(li);
  scrollToBottomIf(stick);
}

function setPartial(text: string): void {
  const stick = isNearBottom();
  ui.partialLine.textContent = text;
  scrollToBottomIf(stick);
}

function clearTranscript(): void {
  segments.length = 0;
  ui.finalList.replaceChildren();
  ui.partialLine.textContent = '';
}

// ---- エンジン ----

function handleAsrEvent(ev: AsrEvent): void {
  switch (ev.type) {
    case 'progress': {
      ui.loadProgress.hidden = false;
      const ratio = ev.total > 0 ? ev.loaded / ev.total : 0;
      ui.loadBar.style.width = `${(ratio * 100).toFixed(1)}%`;
      ui.loadText.textContent = `${mb(ev.loaded)} / ${mb(ev.total)} MB`;
      setPill('モデルを取得中…', 'busy');
      break;
    }
    case 'status':
      setPill(ev.message, 'busy');
      break;
    case 'ready':
      console.info(`model ${ev.modelId} ready in ${ev.loadMs.toFixed(0)} ms (threads=${ev.numThreads})`);
      break;
    case 'partial':
      setPartial(ev.text);
      break;
    case 'final':
      setPartial('');
      if (ev.segment.text) {
        appendSegment(ev.segment);
        sendPanel.dispatch(ev.segment.text, fileBusy);
      }
      ui.statDecode.textContent = `${ev.decodeMs.toFixed(0)} ms`;
      break;
    case 'stats':
      ui.statRtf.textContent = ev.rtf > 0 ? ev.rtf.toFixed(3) : '-';
      ui.statQueue.textContent = recording ? `${ev.queueMs.toFixed(0)} ms` : '-';
      break;
    case 'file-progress': {
      const ratio = ev.totalSec > 0 ? ev.doneSec / ev.totalSec : 0;
      ui.fileBar.style.width = `${(ratio * 100).toFixed(1)}%`;
      ui.fileText.textContent = `${formatClock(ev.doneSec)} / ${formatClock(ev.totalSec)}`;
      break;
    }
    case 'error':
      console.warn('asr:', ev.message);
      break;
    case 'flushed':
    case 'file-done':
      break;
  }
}

function handleAsrState(state: AsrState, detail?: string): void {
  asrState = state;
  switch (state) {
    case 'loading':
      setPill('モデルを読み込み中…', 'busy');
      break;
    case 'ready': {
      setPill(`準備完了: ${currentModel().label}`, 'ok');
      ui.loadProgress.hidden = true;
      void updateStorageInfo();
      void modelPanel.refresh();
      for (const w of readyWaiters) w.resolve();
      readyWaiters = [];
      if (startPending) {
        startPending = false;
        void startRecording();
      }
      break;
    }
    case 'restarting':
      setPill(`自動復帰中: ${detail ?? ''}`, 'busy');
      ui.statRestarts.textContent = `${asr.restartCount} 回`;
      break;
    case 'failed':
      setPill(`停止: ${detail ?? ''}（ここをクリックで再試行）`, 'error');
      startPending = false;
      for (const w of readyWaiters) w.reject(new Error(detail ?? 'モデルの読み込みに失敗しました'));
      readyWaiters = [];
      break;
  }
  updateStartButton();
}

function handleDenoiseState(state: DenoiseState, detail?: string): void {
  const labels: Record<DenoiseState, string> = {
    off: '',
    loading: '読み込み中…',
    ready: '有効',
    failed: '利用不可（素通し）',
  };
  ui.gtcrnState.textContent = detail ? `${labels[state]} ${detail}` : labels[state];
}

function handleCaptureState(state: CaptureState, detail?: string): void {
  if (state === 'running') ui.captureState.textContent = '録音中';
  else if (state === 'recovering') ui.captureState.textContent = `復帰中: ${detail ?? ''}`;
  else ui.captureState.textContent = '';
  if (state !== 'running') ui.levelBar.style.width = '0';
}

const asr = new AsrClient(vendorBase, {onEvent: handleAsrEvent, onState: handleAsrState});
const denoise = new DenoiseClient(vendorBase, (s) => asr.push(s), handleDenoiseState);
const sendPanel = new SendPanel($<HTMLDivElement>('sendPanel'), $<HTMLSpanElement>('sendTabState'), SEND_TARGETS);

const capture = new MicCapture(captureOptions(), {
  onChunk(samples, rms) {
    const db = 20 * Math.log10(rms + 1e-8);
    ui.levelBar.style.width = `${Math.min(100, Math.max(0, (db + 60) / 60 * 100))}%`;
    denoise.push(samples);
  },
  onState: handleCaptureState,
});

const native = new NativeAsr({
  onPartial: setPartial,
  onFinal(seg) {
    appendSegment(seg);
    sendPanel.dispatch(seg.text, false);
  },
  onFatal(message) {
    void stopRecording();
    alert(`音声認識を開始できません: ${message}`);
  },
});

function showNativePill(): void {
  switch (modelPanel.nativeStatus) {
    case 'available':
      setPill(`準備完了: ${currentModel().label}`, 'ok');
      break;
    case 'downloadable':
      setPill('言語パック未取得', '');
      break;
    case 'downloading':
      setPill('言語パックを取得中…', 'busy');
      break;
    case 'unavailable':
      setPill('このブラウザは端末内の音声認識に非対応です', 'error');
      break;
  }
}

function selectModel(spec: ModelSpec): void {
  if (spec.id === settings.modelId) return;
  // ブラウザ標準とモデルをまたぐ切り替えは、使う録音経路が変わるので一旦止める
  if (recording && (spec.kind === 'native') !== isNative()) void stopRecording();
  settings.modelId = spec.id;
  saveSettings(settings);
  renderModelInfo();
  if (spec.kind === 'native') {
    showNativePill();
    updateStartButton();
    return;
  }
  if (asrState === 'idle') setPill('モデル未取得', '');
  // 読み込み済み（または読み込み中）なら新しいモデルで起こし直す。未取得なら開始時に取得する
  if (asrState !== 'idle') loadModel();
  else void modelCacheStatus(spec).then((st) => st === 'cached' && loadModel());
  updateStartButton();
}

const modelPanel = new ModelPanel(ui.modelList, ui.modelDetail, {
  currentId: () => settings.modelId,
  onSelect: selectModel,
  onCacheChanged() {
    void updateStorageInfo();
    if (isNative()) {
      showNativePill();
      updateStartButton();
    }
  },
});

function loadModel(): void {
  if (isNative()) return;
  void navigator.storage?.persist?.();
  asr.load(currentModel(), settings.asr);
}

function ensureModelLoaded(): Promise<void> {
  if (asrState === 'ready') return Promise.resolve();
  if (asrState === 'idle' || asrState === 'failed') loadModel();
  return new Promise((resolve, reject) => readyWaiters.push({resolve, reject}));
}

// ---- 録音 ----

function updateStartButton(): void {
  const b = ui.startBtn;
  b.classList.toggle('recording', recording);
  if (recording) {
    b.textContent = '■ 停止';
    b.disabled = false;
  } else if (isNative()) {
    const labels = {
      available: '● 開始',
      downloadable: '● 開始（初回は言語パックを取得）',
      downloading: '言語パックを取得中…',
      unavailable: '● 開始（このブラウザは非対応）',
    } as const;
    const st = modelPanel.nativeStatus;
    b.textContent = labels[st];
    b.disabled = fileBusy || st === 'downloading' || st === 'unavailable';
  } else if (asrState === 'loading' || asrState === 'restarting' || startPending) {
    b.textContent = '読み込み中…';
    b.disabled = true;
  } else if (asrState === 'ready') {
    b.textContent = '● 開始';
    b.disabled = fileBusy;
  } else {
    b.textContent = `● 開始（初回はモデル取得 約${mb(modelTotalBytes(currentModel()))}MB）`;
    b.disabled = fileBusy;
  }
}

async function requestWakeLock(): Promise<void> {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}

async function startRecording(): Promise<void> {
  if (recording) return;
  if (isNative()) {
    if (modelPanel.nativeStatus !== 'available' && !await modelPanel.installNative()) return;
    if (recording || !isNative()) return;
    recording = true;
    recordingNative = true;
    exportBaseName = '';
    ui.captureState.textContent = '録音中';
    native.start();
    updateStartButton();
    void requestWakeLock();
    return;
  }
  if (asrState !== 'ready') {
    startPending = true;
    updateStartButton();
    void ensureModelLoaded().catch(() => {});
    return;
  }
  try {
    await capture.start();
  } catch (e) {
    alert(`マイクを開始できません: ${String(e)}`);
    return;
  }
  recording = true;
  exportBaseName = '';
  updateStartButton();
  void refreshDevices();
  void requestWakeLock();
}

async function stopRecording(): Promise<void> {
  if (!recording) return;
  recording = false;
  updateStartButton();
  if (recordingNative) {
    recordingNative = false;
    ui.captureState.textContent = '';
    await native.stop();
  } else {
    await capture.stop();
    denoise.reset();
    await asr.flush();
  }
  await wakeLock?.release().catch(() => {});
  wakeLock = null;
}

async function refreshDevices(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  const options = [new Option('既定のデバイス', '')];
  inputs.forEach((d, i) => options.push(new Option(d.label || `マイク ${i + 1}`, d.deviceId)));
  ui.deviceSelect.replaceChildren(...options);
  ui.deviceSelect.value = inputs.some((d) => d.deviceId === settings.deviceId) ? settings.deviceId : '';
}

// ---- ファイル ----

async function transcribeFile(file: File): Promise<void> {
  if (isNative()) {
    ui.fileProgress.hidden = false;
    ui.fileBar.style.width = '0';
    ui.fileText.textContent = 'ブラウザ標準の音声認識はファイルに対応していません。モデルタブで他のモデルを選んでください。';
    ui.fileInput.value = '';
    return;
  }
  if (segments.length > 0 && !confirm('現在の文字起こしを消去して、ファイルを処理しますか？')) return;
  if (recording) await stopRecording();
  fileBusy = true;
  updateStartButton();
  ui.fileProgress.hidden = false;
  ui.fileBar.style.width = '0';
  try {
    ui.fileText.textContent = 'モデルを準備中…';
    await ensureModelLoaded();
    ui.fileText.textContent = '音声をデコード中…';
    let samples = await decodeFileTo16k(file);
    const totalSec = samples.length / SAMPLE_RATE;
    if (settings.gtcrn) {
      ui.fileText.textContent = 'ノイズ除去中…';
      samples = await denoise.processFile(samples);
    }
    clearTranscript();
    exportBaseName = file.name.replace(/\.[^.]+$/, '');
    const t0 = performance.now();
    await asr.transcribeFile(samples);
    const elapsed = (performance.now() - t0) / 1000;
    ui.fileBar.style.width = '100%';
    ui.fileText.textContent =
        `完了: ${formatClock(totalSec)} の音声を ${elapsed.toFixed(1)} 秒で処理（${(totalSec / elapsed).toFixed(1)} 倍速）`;
  } catch (e) {
    ui.fileText.textContent = `失敗: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    fileBusy = false;
    ui.fileInput.value = '';
    updateStartButton();
  }
}

// ---- 書き出し ----

function exportName(ext: string): string {
  if (exportBaseName) return `${exportBaseName}.${ext}`;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `transcript-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

const exporters: Record<string, {fn: (s: Segment[]) => string; mime: string}> = {
  txt: {fn: toTxt, mime: 'text/plain'},
  srt: {fn: toSrt, mime: 'application/x-subrip'},
  vtt: {fn: toVtt, mime: 'text/vtt'},
  json: {fn: toJson, mime: 'application/json'},
};

async function updateStorageInfo(): Promise<void> {
  const est = await navigator.storage?.estimate?.();
  if (est?.usage !== undefined) ui.storageInfo.textContent = `使用中: ${mb(est.usage)} MB`;
}

// ---- 設定 UI ----

function renderModelInfo(): void {
  const m = currentModel();
  modelPanel.render();
  ui.currentModelName.textContent = `モデル: ${m.label}`;
  ui.nativeMicNote.hidden = m.kind !== 'native';
  ui.licenseInfo.textContent = `モデル: ${m.repo}（${m.license}）`;
}

function bindSlider(id: string, key: keyof AsrSettings, digits: number): void {
  const input = $<HTMLInputElement>(id);
  const output = input.parentElement?.querySelector('output');
  const show = () => {
    if (output) output.textContent = Number(input.value).toFixed(digits);
  };
  input.value = String(settings.asr[key]);
  show();
  input.addEventListener('input', show);
  input.addEventListener('change', () => {
    settings.asr = {...settings.asr, [key]: Number(input.value)};
    saveSettings(settings);
    asr.updateSettings(settings.asr);
  });
}

function bindCheckbox(
    input: HTMLInputElement, key: 'browserNoiseSuppression' | 'browserEchoCancellation' |
    'browserAutoGain' | 'gtcrn' | 'showTimestamps', onChange: () => void): void {
  input.checked = settings[key];
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    saveSettings(settings);
    onChange();
  });
}

// <nav class="tabs" data-tabs="X"> と同じ section 内の .tab-panel を切り替える。選択は X ごとに保存
function setupTabs(): void {
  for (const nav of document.querySelectorAll<HTMLElement>('nav.tabs[data-tabs]')) {
    const key = `stt-tab-${nav.dataset.tabs}`;
    const section = nav.parentElement!;
    const tabs = [...nav.querySelectorAll<HTMLButtonElement>('[data-tab]')];
    const panels = [...section.querySelectorAll<HTMLElement>(':scope > .tab-panel')];
    const show = (name: string) => {
      for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
      for (const p of panels) p.hidden = p.dataset.panel !== name;
      localStorage.setItem(key, name);
    };
    for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab!));
    const saved = localStorage.getItem(key);
    show(tabs.some((t) => t.dataset.tab === saved) ? saved! : tabs[0]!.dataset.tab!);
  }
}

function setupUi(): void {
  setupTabs();
  renderModelInfo();
  void modelPanel.refresh();

  ui.deviceSelect.addEventListener('change', () => {
    settings.deviceId = ui.deviceSelect.value;
    saveSettings(settings);
    void capture.setOptions(captureOptions());
  });
  navigator.mediaDevices?.addEventListener('devicechange', () => {
    void refreshDevices();
    void capture.onDeviceChange();
  });

  const applyCapture = () => void capture.setOptions(captureOptions());
  bindCheckbox(ui.optNs, 'browserNoiseSuppression', applyCapture);
  bindCheckbox(ui.optEc, 'browserEchoCancellation', applyCapture);
  bindCheckbox(ui.optAgc, 'browserAutoGain', applyCapture);
  bindCheckbox(ui.optGtcrn, 'gtcrn', () => denoise.setEnabled(settings.gtcrn));
  bindCheckbox(ui.optTimestamps, 'showTimestamps',
               () => ui.transcript.classList.toggle('no-ts', !settings.showTimestamps));
  ui.transcript.classList.toggle('no-ts', !settings.showTimestamps);

  bindSlider('vadThreshold', 'vadThreshold', 2);
  bindSlider('minSilence', 'minSilenceSec', 2);
  bindSlider('minSpeech', 'minSpeechSec', 2);
  bindSlider('maxSpeech', 'maxSpeechSec', 0);
  bindSlider('partialInterval', 'partialIntervalMs', 0);
  bindSlider('numThreads', 'numThreads', 0);
  $<HTMLInputElement>('numThreads').max = String(Math.max(1, navigator.hardwareConcurrency || 4));

  ui.startBtn.addEventListener('click', () => {
    if (recording) void stopRecording();
    else void startRecording();
  });
  ui.engineState.addEventListener('click', () => {
    if (asrState === 'failed') loadModel();
  });

  ui.fileInput.disabled = false;
  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    if (file) void transcribeFile(file);
  });

  ui.copyBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(toTxt(segments));
  });
  ui.clearBtn.addEventListener('click', clearTranscript);
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-export]')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.export ?? 'txt';
      const ex = exporters[kind];
      if (ex) download(exportName(kind), ex.fn(segments), ex.mime);
    });
  }

  ui.clearCacheBtn.addEventListener('click', async () => {
    if (!confirm('ダウンロード済みのモデルを削除しますか？（次回は再ダウンロードになります）')) return;
    await caches.delete(MODEL_CACHE_NAME);
    await updateStorageInfo();
    await modelPanel.refresh();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && recording && !wakeLock) void requestWakeLock();
  });
  addEventListener('beforeunload', (e) => {
    if (recording || fileBusy) e.preventDefault();
  });
}

async function main(): Promise<void> {
  // 動作検証用（tools/e2e.ts の --kill-at から使う）
  if (new URLSearchParams(location.search).has('debug')) {
    Object.assign(window, {__stt: {asr, denoise, capture}});
  }
  setupUi();
  updateStartButton();
  void updateStorageInfo();

  if (!crossOriginIsolated) {
    // coi-serviceworker が登録直後に自動リロードする。それでも駄目なら非対応環境
    ui.isolationWarning.hidden = false;
    ui.isolationWarning.textContent =
        'このページは SharedArrayBuffer（クロスオリジン分離）が必要です。数秒待っても切り替わらない場合は再読み込みしてください。' +
        'プライベートブラウズ等で Service Worker が使えない環境では動作しません。';
    setPill('起動待ち', 'busy');
    ui.startBtn.disabled = true;
    ui.fileInput.disabled = true;
    return;
  }

  denoise.setEnabled(settings.gtcrn);
  if (isNative()) {
    await modelPanel.refresh();
    // 既定値のまま開いた非対応ブラウザ（Chrome 以外）は、ダウンロード型の既定モデルに戻す
    if (modelPanel.nativeStatus === 'unavailable' && !hasSavedSettings()) {
      selectModel(MODELS.find((m) => m.id === FALLBACK_MODEL_ID)!);
      return;
    }
    showNativePill();
    updateStartButton();
  } else if (await modelCacheStatus(currentModel()) === 'cached') loadModel();
  else setPill('モデル未取得', '');
}

void main();
