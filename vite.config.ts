import {defineConfig} from 'vite';
import {viteSingleFile} from 'vite-plugin-singlefile';

// sherpa-onnx の ASR ビルドは pthreads 版なので SharedArrayBuffer (= cross-origin isolation) が必須。
// dev/preview はヘッダーで、surge 本番は public/coi-serviceworker.js で付与する。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  worker: {format: 'iife'},
  build: {target: 'es2022'},
  server: {headers: isolationHeaders},
  preview: {headers: isolationHeaders},
});
