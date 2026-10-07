// マイク入力を 16kHz mono に変換して 100ms ごとに port へ送る AudioWorklet。
// 単一 HTML にまとめるため、関数を toString() して Blob URL から addModule する。
// そのため workletMain() の中から外側の識別子を参照してはいけない。

export const WORKLET_NAME = 'capture-16k';

export interface WorkletChunk {
  samples: Float32Array;
  rms: number;
}

function workletMain(): void {
  const TARGET_RATE = 16000;
  const CHUNK = 1600;

  class Capture16k extends AudioWorkletProcessor {
    ratio = sampleRate / TARGET_RATE;
    out = new Float32Array(CHUNK);
    outLen = 0;
    // ダウンサンプル: 出力 1 サンプルぶんの入力区間を平均する（簡易ローパスを兼ねる）
    consumed = 0;
    emitted = 0;
    nextEdge = Math.floor(sampleRate / TARGET_RATE);
    sum = 0;
    count = 0;
    // アップサンプル（入力 < 16kHz の場合のみ）: 線形補間
    prev = 0;
    phase = 0;

    emit(x: number): void {
      this.out[this.outLen++] = x;
      if (this.outLen === CHUNK) {
        let sq = 0;
        for (let i = 0; i < CHUNK; i++) sq += this.out[i]! * this.out[i]!;
        const samples = this.out;
        this.port.postMessage({samples, rms: Math.sqrt(sq / CHUNK)}, [samples.buffer]);
        this.out = new Float32Array(CHUNK);
        this.outLen = 0;
      }
    }

    process(inputs: Float32Array[][]): boolean {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      if (this.ratio >= 1) {
        for (let i = 0; i < ch.length; i++) {
          this.sum += ch[i]!;
          this.count++;
          this.consumed++;
          if (this.consumed >= this.nextEdge) {
            this.emit(this.sum / this.count);
            this.sum = 0;
            this.count = 0;
            this.emitted++;
            this.nextEdge = Math.floor((this.emitted + 1) * this.ratio);
          }
        }
      } else {
        for (let i = 0; i < ch.length; i++) {
          const x = ch[i]!;
          while (this.phase < 1) {
            this.emit(this.prev + (x - this.prev) * this.phase);
            this.phase += this.ratio;
          }
          this.phase -= 1;
          this.prev = x;
        }
      }
      return true;
    }
  }

  registerProcessor('capture-16k', Capture16k);
}

let workletUrl: string | null = null;

export function getWorkletUrl(): string {
  workletUrl ??= URL.createObjectURL(
      new Blob([`(${workletMain.toString()})();`], {type: 'text/javascript'}));
  return workletUrl;
}
