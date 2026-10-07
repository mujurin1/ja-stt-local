import {MODEL_CACHE_NAME, modelFileUrl} from './models.ts';
import type {ModelSpec} from './protocol.ts';

// Cache Storage にあればそれを返し、無ければ進捗付きで取得して保存する。
// 数百 MB のモデルでもピークメモリを抑えるため、既知サイズの配列へ直接書き込む。
// worker（認識用ロード）と画面（事前ダウンロード）の両方から使う。
export async function fetchCached(
    url: string, expectedBytes: number,
    onProgress: (loaded: number, total: number) => void,
    signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const cache = await caches.open(MODEL_CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) {
    const data = new Uint8Array(await hit.arrayBuffer());
    if (data.byteLength === expectedBytes) {
      onProgress(data.byteLength, data.byteLength);
      return data;
    }
    // 途中で壊れた／モデル更新で中身が変わった → 取り直す
    await cache.delete(url);
  }

  const res = await fetch(url, {signal});
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  const total = Number(res.headers.get('Content-Length')) || expectedBytes;
  let data = new Uint8Array(total);
  let loaded = 0;
  let lastReport = 0;
  const reader = res.body.getReader();
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    if (loaded + value.byteLength > data.byteLength) {
      const grown = new Uint8Array(Math.max(data.byteLength * 2, loaded + value.byteLength));
      grown.set(data.subarray(0, loaded));
      data = grown;
    }
    data.set(value, loaded);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastReport > 200) {
      lastReport = now;
      onProgress(loaded, total);
    }
  }
  onProgress(loaded, loaded);
  if (loaded !== data.byteLength) data = data.slice(0, loaded);

  await cache.put(url, new Response(data));
  return data;
}

export type CacheStatus = 'cached' | 'partial' | 'none';

export async function modelCacheStatus(spec: ModelSpec): Promise<CacheStatus> {
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const files = Object.values(spec.files);
    let hits = 0;
    for (const f of files) {
      if (await cache.match(modelFileUrl(spec, f.path))) hits++;
    }
    return hits === files.length ? 'cached' : hits > 0 ? 'partial' : 'none';
  } catch {
    return 'none';
  }
}

// モデル一式を Cache Storage に取り込む（中身は捨てる。認識時は worker が改めて読む）
export async function downloadModel(
    spec: ModelSpec, onProgress: (loaded: number, total: number) => void,
    signal?: AbortSignal): Promise<void> {
  const files = Object.values(spec.files);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  let done = 0;
  for (const f of files) {
    await fetchCached(modelFileUrl(spec, f.path), f.bytes,
                      (loaded) => onProgress(done + loaded, total), signal);
    done += f.bytes;
  }
}

export async function deleteModel(spec: ModelSpec): Promise<void> {
  const cache = await caches.open(MODEL_CACHE_NAME);
  for (const f of Object.values(spec.files)) await cache.delete(modelFileUrl(spec, f.path));
}
