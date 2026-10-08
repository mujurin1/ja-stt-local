import type {Segment} from './shared/protocol.ts';

// 日本語の文字（ASCII と全角スペース以外）に隣接する空白（半角・全角）を消す。
// 英単語どうしの間（例: "Web Speech"）は残す。Chrome の端末内認識などが単語ごとに空白を挟むため
const JA = '[^\\x00-\\x7F\\u3000]';
const JA_SPACES = new RegExp(`(?<=${JA})[ \\u3000]+|[ \\u3000]+(?=${JA})`, 'g');

export function removeJaSpaces(text: string): string {
  return text.replace(JA_SPACES, '').trim();
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function formatTimestamp(sec: number, msSep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSep}${pad(ms % 1000, 3)}`;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return m >= 60 ?
      `${Math.floor(m / 60)}:${pad(m % 60, 2)}:${pad(s % 60, 2)}` :
      `${pad(m, 2)}:${pad(s % 60, 2)}`;
}

export function toTxt(segments: Segment[]): string {
  return segments.map((s) => s.text).join('\n') + '\n';
}

export function toSrt(segments: Segment[]): string {
  return segments
      .map((s, i) => `${i + 1}\n${formatTimestamp(s.start, ',')} --> ${
                         formatTimestamp(s.end, ',')}\n${s.text}\n`)
      .join('\n');
}

export function toVtt(segments: Segment[]): string {
  return 'WEBVTT\n\n' +
      segments
          .map((s) => `${formatTimestamp(s.start, '.')} --> ${
                           formatTimestamp(s.end, '.')}\n${s.text}\n`)
          .join('\n');
}

export function toJson(segments: Segment[]): string {
  return JSON.stringify(segments, null, 2);
}

export function download(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], {type: mime}));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
