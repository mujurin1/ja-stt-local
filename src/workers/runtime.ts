// Emscripten glue（classic script）を worker 内で読み込んで初期化を待つ。

export interface RuntimeOptions {
  // 末尾に "/" を含む vendor ディレクトリの絶対 URL
  base: string;
  // glue より先に読む API ラッパー（sherpa-onnx-asr.js など）
  scripts: string[];
  glue: string;
  // pthreads ビルドなら共有メモリを外から渡す（ヒープビューの同期に使う）
  sharedMemoryPages?: number;
  onAbort: (message: string) => void;
}

let memory: WebAssembly.Memory | null = null;

export function loadRuntime(opts: RuntimeOptions): Promise<SherpaModule> {
  return new Promise((resolve, reject) => {
    if (opts.sharedMemoryPages) {
      memory = new WebAssembly.Memory(
          {initial: opts.sharedMemoryPages, maximum: 32768, shared: true});
    }
    const mod: SherpaModuleInit = {
      locateFile: (path) => opts.base + path,
      // inline worker (blob:) から pthread worker を起こすため glue の絶対 URL を渡す
      mainScriptUrlOrBlob: opts.base + opts.glue,
      onRuntimeInitialized: () => resolve(globalThis.Module),
      onAbort: (what) => {
        const message = `wasm abort: ${String(what)}`;
        opts.onAbort(message);
        reject(new Error(message));
      },
      print: () => {},
      printErr: (text) => console.warn(text),
    };
    if (memory) mod.wasmMemory = memory;
    // glue が `var Module = typeof Module != "undefined" ? Module : {}` で拾って拡張する
    globalThis.Module = mod as SherpaModule;
    try {
      importScripts(...opts.scripts.map((s) => opts.base + s), opts.base + opts.glue);
    } catch (e) {
      reject(e);
    }
  });
}

// 共有メモリが pthread 側で grow された場合、Module.HEAP* が古いバッファを指したままになり得る。
// vendor の API ラッパーは Module.HEAPF32 等を直接触るので、呼び出し前に揃えておく。
export function syncHeap(mod: SherpaModule): void {
  if (!memory) return;
  const buffer = memory.buffer;
  if (mod.HEAPU8.byteLength === buffer.byteLength) return;
  mod.HEAPU8 = new Uint8Array(buffer);
  mod.HEAP16 = new Int16Array(buffer);
  mod.HEAP32 = new Int32Array(buffer);
  mod.HEAPU32 = new Uint32Array(buffer);
  mod.HEAPF32 = new Float32Array(buffer);
  mod.HEAPF64 = new Float64Array(buffer);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
