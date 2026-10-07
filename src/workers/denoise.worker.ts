// GTCRN によるストリーミングノイズ除去 worker（16kHz mono in/out）。
import {SAMPLE_RATE} from '../shared/protocol.ts';
import type {DenoiseEvent, DenoiseRequest} from '../shared/protocol.ts';
import {errorMessage, loadRuntime} from './runtime.ts';

let denoiser: OnlineSpeechDenoiser | null = null;

function post(ev: DenoiseEvent, transfer: Transferable[] = []): void {
  postMessage(ev, transfer);
}

async function init(vendorBase: string): Promise<void> {
  const m = await loadRuntime({
    base: vendorBase + 'sherpa-denoise/',
    scripts: ['sherpa-onnx-speech-enhancement.js'],
    glue: 'sherpa-onnx-wasm-main-speech-enhancement.js',
    onAbort: (message) => post({type: 'error', message, fatal: true}),
  });
  // gtcrn.onnx は同梱の .data から MEMFS に展開済み
  denoiser = createOnlineSpeechDenoiser(m, {
    model: {gtcrn: {model: './gtcrn.onnx'}, numThreads: 1, debug: 0},
  });
  if (!denoiser.handle) throw new Error('ノイズ除去の初期化に失敗しました');
  post({type: 'ready'});
}

function runFile(jobId: number, samples: Float32Array): void {
  const d = denoiser;
  if (!d) throw new Error('ノイズ除去が未初期化です');
  d.reset();
  const out = new Float32Array(samples.length + SAMPLE_RATE);
  let written = 0;
  const append = (x: Float32Array) => {
    const n = Math.min(x.length, out.length - written);
    out.set(x.subarray(0, n), written);
    written += n;
  };
  for (let off = 0; off < samples.length; off += SAMPLE_RATE) {
    append(d.run(samples.subarray(off, off + SAMPLE_RATE), SAMPLE_RATE).samples);
  }
  append(d.flush().samples);
  d.reset();
  const result = out.slice(0, written);
  post({type: 'file-done', jobId, samples: result}, [result.buffer]);
}

addEventListener('message', (e: MessageEvent<DenoiseRequest>) => {
  const req = e.data;
  try {
    switch (req.type) {
      case 'init':
        init(req.vendorBase).catch((err: unknown) =>
          post({type: 'error', message: errorMessage(err), fatal: true}));
        break;
      case 'audio': {
        if (!denoiser) {
          // 未初期化の間は素通し（音声を止めない）
          post({type: 'audio', samples: req.samples, sentAt: req.sentAt}, [req.samples.buffer]);
          break;
        }
        const out = denoiser.run(req.samples, SAMPLE_RATE).samples;
        if (out.length > 0) post({type: 'audio', samples: out, sentAt: req.sentAt}, [out.buffer]);
        break;
      }
      case 'reset':
        denoiser?.reset();
        break;
      case 'file':
        runFile(req.jobId, req.samples);
        break;
    }
  } catch (err) {
    post({type: 'error', message: errorMessage(err), fatal: true});
  }
});
