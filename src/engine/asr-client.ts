// ASR worker の起動・監視・自動再起動。
// worker が落ちたり固まったりしても、同じモデル（Cache Storage から即ロード）で起こし直して続行する。
import AsrWorker from '../workers/asr.worker.ts?worker&inline';
import {SAMPLE_RATE} from '../shared/protocol.ts';
import type {AsrEvent, AsrRequest, AsrSettings, ModelSpec} from '../shared/protocol.ts';

export type AsrState = 'loading' | 'ready' | 'restarting' | 'failed';

export interface AsrClientEvents {
  // 時刻は worker の再起動をまたいでも連続するよう補正済み
  onEvent(ev: AsrEvent): void;
  onState(state: AsrState, detail?: string): void;
}

const HANG_MS = 15000;
const RESTART_WINDOW_MS = 60000;
const MAX_RESTARTS_IN_WINDOW = 3;

export class AsrClient {
  vendorBase: string;
  events: AsrClientEvents;
  model: ModelSpec | null = null;
  settings: AsrSettings | null = null;
  worker: Worker | null = null;
  ready = false;
  fileJobActive = false;
  // 現 worker に送ったサンプル数と、過去の worker ぶんの時刻オフセット（秒）
  sentSamples = 0;
  timeOffset = 0;
  lastHeard = 0;
  restartTimes: number[] = [];
  restartCount = 0;
  watchdog = 0;
  pending = new Map<string, (ev: AsrEvent) => void>();
  nextJobId = 1;

  constructor(vendorBase: string, events: AsrClientEvents) {
    this.vendorBase = vendorBase;
    this.events = events;
    this.watchdog = window.setInterval(() => this.check(), 2000);
  }

  load(model: ModelSpec, settings: AsrSettings): void {
    this.model = model;
    this.settings = settings;
    this.restartTimes = [];
    this.spawn();
  }

  updateSettings(settings: AsrSettings): void {
    const threadsChanged = this.settings?.numThreads !== settings.numThreads;
    this.settings = settings;
    if (!this.worker) return;
    // スレッド数は認識器の作成時にしか効かないので作り直す
    if (threadsChanged) this.spawn();
    else if (this.ready) this.send({type: 'settings', settings});
  }

  push(samples: Float32Array): void {
    if (!this.ready || !this.worker || this.fileJobActive) return;
    this.sentSamples += samples.length;
    this.send({type: 'audio', samples, sentAt: Date.now()}, [samples.buffer]);
  }

  flush(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete('flushed');
        resolve();
      }, 10000);
      this.pending.set('flushed', () => {
        clearTimeout(timer);
        resolve();
      });
      this.send({type: 'flush'});
    });
  }

  transcribeFile(samples: Float32Array): Promise<void> {
    if (!this.ready) return Promise.reject(new Error('モデルの準備ができていません'));
    const jobId = this.nextJobId++;
    this.fileJobActive = true;
    return new Promise<void>((resolve, reject) => {
      this.pending.set('file-done', () => resolve());
      this.pending.set('file-failed', (ev) =>
        reject(new Error(ev.type === 'error' ? ev.message : 'ファイル処理に失敗しました')));
      this.send({type: 'file', jobId, samples}, [samples.buffer]);
    }).finally(() => {
      this.fileJobActive = false;
      this.pending.delete('file-done');
      this.pending.delete('file-failed');
    });
  }

  dispose(): void {
    clearInterval(this.watchdog);
    this.terminate();
  }

  private send(req: AsrRequest, transfer: Transferable[] = []): void {
    this.worker?.postMessage(req, transfer);
  }

  private spawn(): void {
    const model = this.model;
    const settings = this.settings;
    if (!model || !settings) return;
    this.terminate();
    const worker = new AsrWorker();
    this.worker = worker;
    this.ready = false;
    this.lastHeard = performance.now();
    worker.onmessage = (e: MessageEvent<AsrEvent>) => {
      if (this.worker === worker) this.handle(e.data);
    };
    worker.onerror = (e) => {
      if (this.worker === worker) this.restart(`worker エラー: ${e.message}`);
    };
    this.events.onState('loading');
    this.send({type: 'init', vendorBase: this.vendorBase, model, settings});
  }

  private terminate(): void {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.ready = false;
    this.timeOffset += this.sentSamples / SAMPLE_RATE;
    this.sentSamples = 0;
    // 待っている flush / ファイル処理は失敗扱いで解放する
    this.pending.get('flushed')?.({type: 'flushed'});
    this.pending.get('file-failed')?.({type: 'error', message: 'worker が再起動されました', fatal: true});
    this.pending.clear();
  }

  private handle(ev: AsrEvent): void {
    this.lastHeard = performance.now();
    switch (ev.type) {
      case 'ready':
        this.ready = true;
        this.events.onState('ready');
        break;
      case 'error':
        if (ev.fatal) {
          this.restart(ev.message);
          return;
        }
        break;
      case 'flushed':
        this.pending.get('flushed')?.(ev);
        this.pending.delete('flushed');
        break;
      case 'file-done':
        this.pending.get('file-done')?.(ev);
        break;
      case 'partial':
        ev = {...ev, start: ev.start + this.timeOffset};
        break;
      case 'final':
        // ファイル処理中の時刻はファイル先頭基準のまま
        if (!this.fileJobActive) {
          ev = {
            ...ev,
            segment: {
              ...ev.segment,
              start: ev.segment.start + this.timeOffset,
              end: ev.segment.end + this.timeOffset,
            },
          };
        }
        break;
    }
    this.events.onEvent(ev);
  }

  private restart(reason: string): void {
    const now = performance.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_RESTARTS_IN_WINDOW) {
      this.terminate();
      this.events.onState('failed', reason);
      return;
    }
    this.restartTimes.push(now);
    this.restartCount++;
    this.terminate();
    this.events.onState('restarting', reason);
    setTimeout(() => this.spawn(), 300);
  }

  private check(): void {
    if (!this.worker || !this.ready || this.fileJobActive) return;
    if (performance.now() - this.lastHeard > HANG_MS) this.restart('worker が応答しません');
  }
}
