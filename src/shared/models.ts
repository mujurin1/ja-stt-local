import type {ModelSpec} from './protocol.ts';

// モデルは HF から実行時に取得し、Cache Storage に保存する。
// bytes は進捗表示用（Content-Length が取れない場合のフォールバック）。
export const MODELS: ModelSpec[] = [
  {
    id: 'reazon-v2',
    label: 'ReazonSpeech v2',
    tag: 'おすすめ',
    note: '日本語特化の Zipformer。精度と速度のバランスが良い。句読点なし。',
    repo: 'csukuangfj/reazonspeech-k2-v2',
    kind: 'transducer',
    files: {
      encoder: {path: 'encoder-epoch-99-avg-1.int8.onnx', bytes: 154670139},
      decoder: {path: 'decoder-epoch-99-avg-1.onnx', bytes: 11767836},
      joiner: {path: 'joiner-epoch-99-avg-1.int8.onnx', bytes: 2696970},
      tokens: {path: 'tokens.txt', bytes: 45754},
    },
    license: 'Apache-2.0',
    commercial: 'ok',
  },
  {
    id: 'reazon-v2-ja-en',
    label: 'ReazonSpeech ja-en',
    tag: '軽量・日英',
    note: '日本語+英語。低スペック向け。句読点なし。',
    repo: 'csukuangfj/reazonspeech-k2-v2-ja-en',
    kind: 'transducer',
    files: {
      encoder: {path: 'encoder-epoch-35-avg-1.int8.onnx', bytes: 70876409},
      decoder: {path: 'decoder-epoch-35-avg-1.int8.onnx', bytes: 1308690},
      joiner: {path: 'joiner-epoch-35-avg-1.int8.onnx', bytes: 1033417},
      tokens: {path: 'tokens.txt', bytes: 26631},
    },
    license: '未記載（reazon-research/reazonspeech-k2-v2-ja-en）',
    commercial: 'check',
  },
  {
    id: 'sense-voice',
    label: 'SenseVoice Small',
    tag: '句読点あり',
    note: '中英日韓粤。非自己回帰で高速。句読点・ITN あり。',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    kind: 'senseVoice',
    files: {
      model: {path: 'model.int8.onnx', bytes: 239233841},
      tokens: {path: 'tokens.txt', bytes: 315894},
    },
    license: 'FunASR Model License',
    commercial: 'check',
  },
  {
    id: 'parakeet-ja',
    label: 'Parakeet 0.6B ja',
    tag: '高精度',
    note: 'NVIDIA 製。高精度だが初回 DL とメモリが重い。句読点あり。',
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8',
    kind: 'nemoCtc',
    files: {
      model: {path: 'model.int8.onnx', bytes: 655542604},
      tokens: {path: 'tokens.txt', bytes: 28557},
    },
    license: 'CC-BY-4.0',
    commercial: 'ok',
  },
  {
    id: 'moonshine-tiny-ja',
    label: 'Moonshine tiny ja',
    tag: '最軽量',
    note: '最軽量。1 区間 6 秒までに分割して認識。',
    repo: 'csukuangfj2/sherpa-onnx-moonshine-tiny-ja-quantized-2026-02-27',
    kind: 'moonshine',
    files: {
      encoder: {path: 'encoder_model.ort', bytes: 13238184},
      mergedDecoder: {path: 'decoder_model_merged.ort', bytes: 58327272},
      tokens: {path: 'tokens.txt', bytes: 549350},
    },
    license: 'Moonshine Community License',
    commercial: 'ng',
    maxSegmentSec: 6,
  },
  {
    id: 'moonshine-base-ja',
    label: 'Moonshine base ja',
    tag: '',
    note: 'tiny より高精度。1 区間 6 秒までに分割して認識。',
    repo: 'csukuangfj2/sherpa-onnx-moonshine-base-ja-quantized-2026-02-27',
    kind: 'moonshine',
    files: {
      encoder: {path: 'encoder_model.ort', bytes: 31326816},
      mergedDecoder: {path: 'decoder_model_merged.ort', bytes: 109424424},
      tokens: {path: 'tokens.txt', bytes: 549350},
    },
    license: 'Moonshine Community License',
    commercial: 'ng',
    maxSegmentSec: 6,
  },
];

export const DEFAULT_MODEL_ID = 'reazon-v2';

export const MODEL_CACHE_NAME = 'stt-models-v1';

export function modelFileUrl(spec: ModelSpec, path: string): string {
  return `https://huggingface.co/${spec.repo}/resolve/main/${path}`;
}

export function modelTotalBytes(spec: ModelSpec): number {
  return Object.values(spec.files).reduce((sum, f) => sum + f.bytes, 0);
}
