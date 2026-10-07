// AudioWorkletGlobalScope の型（DOM lib には含まれないため最小限を宣言）。
// worklet.ts の workletMain() 内でだけ使う。

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(
    name: string,
    processorCtor: new () => AudioWorkletProcessor & {
      process(inputs: Float32Array[][]): boolean;
    }): void;

declare const sampleRate: number;
