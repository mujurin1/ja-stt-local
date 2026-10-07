import {SAMPLE_RATE} from '../shared/protocol.ts';

// ブラウザがデコードできる音声／動画ファイルを 16kHz mono に変換する。
export async function decodeFileTo16k(file: File): Promise<Float32Array> {
  const buf = await file.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(buf);
  const length = Math.ceil(decoded.duration * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}
