// main <-> worker 間のメッセージ定義。時刻はすべて秒（worker 側のリセット起点からの相対）。

export const SAMPLE_RATE = 16000;

export type ModelKind = 'transducer' | 'senseVoice' | 'nemoCtc' | 'moonshine';
export type ModelFileRole =
    'encoder' | 'decoder' | 'joiner' | 'model' | 'mergedDecoder' | 'tokens';

export interface ModelFile {
  path: string;
  bytes: number;
}

export interface ModelSpec {
  id: string;
  label: string;
  // 一覧で名前の横に出す一言（おすすめ／軽量 など）
  tag: string;
  note: string;
  repo: string;
  kind: ModelKind;
  files: Partial<Record<ModelFileRole, ModelFile>>;
  license: string;
  commercial: 'ok' | 'check' | 'ng';
  // 1 回の認識に渡せる発話の上限（秒）。超えるとモデル内部で例外になるもの用
  maxSegmentSec?: number;
}

export interface AsrSettings {
  vadThreshold: number;
  minSilenceSec: number;
  minSpeechSec: number;
  maxSpeechSec: number;
  partialIntervalMs: number;
  numThreads: number;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export type AsrRequest =
    | {type: 'init'; vendorBase: string; model: ModelSpec; settings: AsrSettings}
    | {type: 'audio'; samples: Float32Array; sentAt: number}
    | {type: 'settings'; settings: AsrSettings}
    | {type: 'flush'}
    | {type: 'file'; jobId: number; samples: Float32Array};

export type AsrEvent =
    | {type: 'progress'; label: string; loaded: number; total: number}
    | {type: 'status'; message: string}
    | {type: 'ready'; modelId: string; loadMs: number; numThreads: number}
    | {type: 'partial'; start: number; text: string}
    | {type: 'final'; segment: Segment; decodeMs: number}
    | {
        type: 'stats';
        processedSec: number;
        speech: boolean;
        queueMs: number;
        lastDecodeMs: number;
        rtf: number;
      }
    | {type: 'flushed'}
    | {type: 'file-progress'; jobId: number; doneSec: number; totalSec: number}
    | {type: 'file-done'; jobId: number; elapsedMs: number}
    | {type: 'error'; message: string; fatal: boolean};

export type DenoiseRequest =
    | {type: 'init'; vendorBase: string}
    | {type: 'audio'; samples: Float32Array; sentAt: number}
    | {type: 'reset'}
    | {type: 'file'; jobId: number; samples: Float32Array};

export type DenoiseEvent =
    | {type: 'ready'}
    | {type: 'audio'; samples: Float32Array; sentAt: number}
    | {type: 'file-done'; jobId: number; samples: Float32Array}
    | {type: 'error'; message: string; fatal: boolean};
