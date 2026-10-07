// GTCRN ノイズ除去 worker。無効時・未初期化時・故障時は素通しにして音声を止めない。
import DenoiseWorker from '../workers/denoise.worker.ts?worker&inline';
import type {DenoiseEvent, DenoiseRequest} from '../shared/protocol.ts';

export type DenoiseState = 'off' | 'loading' | 'ready' | 'failed';

export class DenoiseClient {
  vendorBase: string;
  onAudio: (samples: Float32Array) => void;
  onState: (state: DenoiseState, detail?: string) => void;
  enabled = false;
  worker: Worker | null = null;
  ready = false;
  failures = 0;
  fileJobs = new Map<number, {resolve: (s: Float32Array) => void; reject: (e: Error) => void}>();
  nextJobId = 1;

  constructor(
      vendorBase: string, onAudio: (samples: Float32Array) => void,
      onState: (state: DenoiseState, detail?: string) => void) {
    this.vendorBase = vendorBase;
    this.onAudio = onAudio;
    this.onState = onState;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled && !this.worker) this.spawn();
    if (!enabled) {
      this.send({type: 'reset'});
      this.onState('off');
    } else if (this.ready) {
      this.onState('ready');
    }
  }

  push(samples: Float32Array): void {
    if (!this.enabled || !this.ready || !this.worker) {
      this.onAudio(samples);
      return;
    }
    this.send({type: 'audio', samples, sentAt: Date.now()}, [samples.buffer]);
  }

  reset(): void {
    this.send({type: 'reset'});
  }

  async processFile(samples: Float32Array): Promise<Float32Array> {
    if (!this.enabled || !this.ready) return samples;
    const jobId = this.nextJobId++;
    return new Promise((resolve, reject) => {
      this.fileJobs.set(jobId, {resolve, reject});
      this.send({type: 'file', jobId, samples}, [samples.buffer]);
    });
  }

  private send(req: DenoiseRequest, transfer: Transferable[] = []): void {
    this.worker?.postMessage(req, transfer);
  }

  private spawn(): void {
    const worker = new DenoiseWorker();
    this.worker = worker;
    this.ready = false;
    this.onState('loading');
    worker.onmessage = (e: MessageEvent<DenoiseEvent>) => this.handle(e.data);
    worker.onerror = (e) => this.fail(`worker エラー: ${e.message}`);
    this.send({type: 'init', vendorBase: this.vendorBase});
  }

  private handle(ev: DenoiseEvent): void {
    switch (ev.type) {
      case 'ready':
        this.ready = true;
        this.failures = 0;
        if (this.enabled) this.onState('ready');
        break;
      case 'audio':
        this.onAudio(ev.samples);
        break;
      case 'file-done':
        this.fileJobs.get(ev.jobId)?.resolve(ev.samples);
        this.fileJobs.delete(ev.jobId);
        break;
      case 'error':
        if (ev.fatal) this.fail(ev.message);
        break;
    }
  }

  private fail(reason: string): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    for (const job of this.fileJobs.values()) job.reject(new Error(`ノイズ除去に失敗: ${reason}`));
    this.fileJobs.clear();
    this.failures++;
    // 2 回までは起こし直す。それ以上は素通しで運用を続ける
    if (this.enabled && this.failures <= 2) {
      this.onState('loading', `再起動中: ${reason}`);
      setTimeout(() => this.spawn(), 500);
    } else {
      this.onState('failed', reason);
    }
  }
}
