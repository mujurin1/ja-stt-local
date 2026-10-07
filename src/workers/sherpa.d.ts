// public/vendor の sherpa-onnx JS（importScripts で読む classic script）が定義するグローバルの型。
// 使う範囲だけ宣言している。

// glue 読み込み前に globalThis.Module へ置いておく設定
interface SherpaModuleInit {
  locateFile?: (path: string, scriptDirectory: string) => string;
  mainScriptUrlOrBlob?: string;
  wasmMemory?: WebAssembly.Memory;
  onRuntimeInitialized?: () => void;
  onAbort?: (what: unknown) => void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  setStatus?: (text: string) => void;
}

interface SherpaModule extends SherpaModuleInit {
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  FS_createDataFile(
      parent: string, name: string, data: Uint8Array, canRead: boolean,
      canWrite: boolean, canOwn: boolean): void;
  FS_unlink(path: string): void;
}

declare var Module: SherpaModule;

interface OfflineRecognizerResult {
  text: string;
}

declare class OfflineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
}

declare class OfflineRecognizer {
  constructor(config: object, module: SherpaModule);
  handle: number;
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): OfflineRecognizerResult;
  free(): void;
}

interface SileroVadConfig {
  model: string;
  threshold: number;
  minSilenceDuration: number;
  minSpeechDuration: number;
  maxSpeechDuration: number;
  windowSize: number;
}

interface VadConfig {
  sileroVad: SileroVadConfig;
  // ラッパーが構造体を詰める際に参照するので、未使用でも空 model で渡す
  tenVad: SileroVadConfig;
  sampleRate: number;
  numThreads: number;
  provider: string;
  debug: number;
  bufferSizeInSeconds: number;
}

declare class Vad {
  handle: number;
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  front(): {samples: Float32Array; start: number};
  pop(): void;
  flush(): void;
  reset(): void;
  free(): void;
}

declare function createVad(module: SherpaModule, config: VadConfig): Vad;

declare class OnlineSpeechDenoiser {
  handle: number;
  sampleRate: number;
  run(samples: Float32Array, sampleRate: number):
      {samples: Float32Array; sampleRate: number};
  flush(): {samples: Float32Array; sampleRate: number};
  reset(): void;
  free(): void;
}

declare function createOnlineSpeechDenoiser(
    module: SherpaModule, config: object): OnlineSpeechDenoiser;
