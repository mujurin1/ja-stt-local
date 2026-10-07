// マイク取得と自動復帰。
// 「止まる」原因（トラック終了、AudioContext の suspend、音声フレームの途絶、デバイス抜き差し）を
// それぞれ監視し、検知したら取り直す。
import {getWorkletUrl, WORKLET_NAME} from './worklet.ts';
import type {WorkletChunk} from './worklet.ts';

export interface CaptureOptions {
  deviceId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export type CaptureState = 'running' | 'recovering' | 'stopped';

export interface CaptureEvents {
  onChunk(samples: Float32Array, rms: number): void;
  onState(state: CaptureState, detail?: string): void;
}

const STALL_MS = 3000;
const MAX_RETRY_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MicCapture {
  opts: CaptureOptions;
  events: CaptureEvents;
  running = false;
  recovering = false;
  ctx: AudioContext | null = null;
  stream: MediaStream | null = null;
  node: AudioWorkletNode | null = null;
  lastChunkAt = 0;
  watchdog = 0;
  inputRate = 0;

  constructor(opts: CaptureOptions, events: CaptureEvents) {
    this.opts = opts;
    this.events = events;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.open();
    } catch (e) {
      this.running = false;
      await this.close();
      throw e;
    }
    this.events.onState('running');
    this.watchdog = window.setInterval(() => this.check(), 1000);
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.watchdog);
    await this.close();
    this.events.onState('stopped');
  }

  async setOptions(opts: CaptureOptions): Promise<void> {
    this.opts = opts;
    if (this.running) await this.recover('入力設定を変更');
  }

  // 使用中のデバイスが消えたら既定デバイスで取り直す
  async onDeviceChange(): Promise<void> {
    if (!this.running || !this.opts.deviceId) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === 'audioinput' && d.deviceId === this.opts.deviceId)) {
      this.opts = {...this.opts, deviceId: ''};
      await this.recover('入力デバイスが見つからないため既定に切替');
    }
  }

  private async open(): Promise<void> {
    const {deviceId, noiseSuppression, echoCancellation, autoGainControl} = this.opts;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? {exact: deviceId} : undefined,
        channelCount: 1,
        noiseSuppression,
        echoCancellation,
        autoGainControl,
      },
    });
    this.stream = stream;

    const {ctx, source} = await this.createGraphSource(stream);
    this.ctx = ctx;
    this.inputRate = ctx.sampleRate;
    const node = new AudioWorkletNode(ctx, WORKLET_NAME, {numberOfInputs: 1, numberOfOutputs: 1});
    node.port.onmessage = (e: MessageEvent<WorkletChunk>) => {
      this.lastChunkAt = performance.now();
      this.events.onChunk(e.data.samples, e.data.rms);
    };
    source.connect(node);
    // 出力は無音。destination に繋がないと処理されないブラウザがあるため繋いでおく
    node.connect(ctx.destination);
    this.node = node;
    this.lastChunkAt = performance.now();

    for (const track of stream.getAudioTracks()) {
      track.onended = () => void this.recover('マイクが切断されました');
    }
    ctx.onstatechange = () => {
      if (this.running && ctx.state !== 'running' && ctx.state !== 'closed') {
        void ctx.resume().catch(() => {});
      }
    };
    if (ctx.state !== 'running') await ctx.resume();
  }

  // 16kHz の AudioContext で直接取れればブラウザの高品質リサンプラを使う。
  // 異なるレートの MediaStream を繋げないブラウザでは既定レートにして worklet 側で変換する。
  private async createGraphSource(stream: MediaStream):
      Promise<{ctx: AudioContext; source: MediaStreamAudioSourceNode}> {
    for (const rate of [16000, undefined]) {
      let ctx: AudioContext | null = null;
      try {
        ctx = new AudioContext(rate ? {sampleRate: rate, latencyHint: 'interactive'} : {});
        await ctx.audioWorklet.addModule(getWorkletUrl());
        const source = ctx.createMediaStreamSource(stream);
        return {ctx, source};
      } catch (e) {
        await ctx?.close().catch(() => {});
        if (rate === undefined) throw e;
      }
    }
    throw new Error('unreachable');
  }

  private async close(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    for (const t of this.stream?.getTracks() ?? []) {
      t.onended = null;
      t.stop();
    }
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      ctx.onstatechange = null;
      await ctx.close().catch(() => {});
    }
  }

  private check(): void {
    if (!this.running || this.recovering) return;
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    if (performance.now() - this.lastChunkAt > STALL_MS) {
      void this.recover('音声入力が途絶えました');
    }
  }

  private async recover(reason: string): Promise<void> {
    if (this.recovering || !this.running) return;
    this.recovering = true;
    this.events.onState('recovering', reason);
    await this.close();
    let delay = 300;
    let attempt = 0;
    while (this.running) {
      try {
        await this.open();
        this.recovering = false;
        this.events.onState('running');
        return;
      } catch (e) {
        attempt++;
        // 指定デバイスで取れないなら既定デバイスに落とす
        if (attempt >= 2 && this.opts.deviceId) this.opts = {...this.opts, deviceId: ''};
        await this.close();
        this.events.onState('recovering', `${reason}（再試行 ${attempt}: ${String(e)}）`);
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
      }
    }
    this.recovering = false;
  }
}
