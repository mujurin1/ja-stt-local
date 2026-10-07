// VOICEVOX エンジン（ユーザー PC 上の http://127.0.0.1:50021）で 1 文ずつ合成し、ブラウザで順番に再生する。
// 流れ: POST /audio_query?text=&speaker= → 返った JSON の各 Scale を上書き → POST /synthesis?speaker= → audio/wav
import type {SendResult, SpeechSender} from './types.ts';

export interface VoicevoxConfig {
  baseUrl: string;
  // スタイル ID（/speakers の styles[].id）
  speaker: number;
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
}

export const DEFAULT_VOICEVOX_CONFIG: VoicevoxConfig = {
  baseUrl: 'http://127.0.0.1:50021',
  speaker: 3, // ずんだもん（ノーマル）
  speedScale: 1,
  pitchScale: 0,
  intonationScale: 1,
  volumeScale: 1,
};

// 設定 UI 用の目安（VOICEVOX アプリのスライダー範囲）
export const VOICEVOX_PARAM_RANGES = {
  speedScale: {min: 0.5, max: 2, step: 0.05},
  pitchScale: {min: -0.15, max: 0.15, step: 0.01},
  intonationScale: {min: 0, max: 2, step: 0.05},
  volumeScale: {min: 0, max: 2, step: 0.05},
} as const;

export const VOICEVOX_SETUP_HELP = [
  'VOICEVOX（アプリまたはエンジン）を起動しておいてください（既定: http://127.0.0.1:50021）',
  '初期設定ではこのサイトからの接続は拒否されます',
  'ブラウザで http://127.0.0.1:50021/setting を開き、「Allow Origin」欄に ' + location.origin + ' を追加して保存し、VOICEVOX を再起動してください',
  '（エンジン単体なら起動オプション --allow_origin ' + location.origin + ' でも可）',
  'Chrome で「ローカル ネットワーク上のデバイスへのアクセス」の許可を求められたら「許可」を選んでください',
].join('\n');

export interface VoicevoxSpeaker {
  id: number;
  name: string;
}

interface SpeakerJson {
  name: string;
  styles: {name: string; id: number; type?: string}[];
}

const TIMEOUT_MS = 30_000;
const RESUME_TIMEOUT_MS = 2_000;

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

// fetch の失敗理由を利用者向けの日本語に置き換える
async function request(baseUrl: string, path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const url = trimBase(baseUrl) + path;
  let res: Response;
  try {
    res = await fetch(url, {...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs)});
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new Error(`VOICEVOX が応答しません（${timeoutMs / 1000} 秒でタイムアウト）: ${url}`);
    }
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    // CORS 拒否・未起動・LNA 拒否はどれも TypeError になり区別できない
    throw new Error(
      `VOICEVOX に接続できません（${url}）。VOICEVOX が起動しているか、` +
        `設定 (${trimBase(baseUrl)}/setting) の「Allow Origin」欄に ${location.origin} を追加して再起動したかを確認してください。`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`VOICEVOX がエラーを返しました（${res.status}）: ${body.slice(0, 200)}`);
  }
  return res;
}

// 全キャラのトーク用スタイルを「キャラ名（スタイル名）」で平らに並べる
export async function listVoicevoxSpeakers(baseUrl: string): Promise<VoicevoxSpeaker[]> {
  const res = await request(baseUrl, '/speakers', {}, 10_000);
  const speakers = (await res.json()) as SpeakerJson[];
  return speakers.flatMap((s) =>
    s.styles
      .filter((st) => st.type === undefined || st.type === 'talk')
      .map((st) => ({id: st.id, name: `${s.name}（${st.name}）`})),
  );
}

export function createVoicevoxSender(config: VoicevoxConfig): SpeechSender<VoicevoxConfig> {
  let ctx: AudioContext | null = null;
  let current: AudioBufferSourceNode | null = null;
  // 合成は直列（エンジンへ同時に投げない）、再生も直列。合成は再生を待たずに先行する
  let synthTail: Promise<unknown> = Promise.resolve();
  let playTail: Promise<unknown> = Promise.resolve();
  // dispose 後に積まれていた再生を捨てるための世代番号
  let generation = 0;
  let lastPlayError = '';
  const aborter = new AbortController();

  async function synthesize(text: string, c: VoicevoxConfig): Promise<ArrayBuffer> {
    const signal = AbortSignal.any([aborter.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const q = new URLSearchParams({text, speaker: String(c.speaker)});
    const queryRes = await request(c.baseUrl, `/audio_query?${q}`, {method: 'POST', signal});
    const query = (await queryRes.json()) as Record<string, unknown>;
    query.speedScale = c.speedScale;
    query.pitchScale = c.pitchScale;
    query.intonationScale = c.intonationScale;
    query.volumeScale = c.volumeScale;
    const wavRes = await request(c.baseUrl, `/synthesis?speaker=${c.speaker}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(query),
      signal,
    });
    return wavRes.arrayBuffer();
  }

  // ブラウザの自動再生制限で resume が保留されたままになることがあるので、待ち続けずにエラーにする
  async function ensureContext(): Promise<AudioContext> {
    ctx ??= new AudioContext();
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, RESUME_TIMEOUT_MS))]);
    }
    if (ctx.state !== 'running') {
      throw new Error('ブラウザが音声の再生を許可していません。ページ内のボタン（テスト送信など）を一度押してから再度お試しください');
    }
    return ctx;
  }

  async function play(wav: ArrayBuffer, gen: number): Promise<void> {
    if (gen !== generation) return;
    const ctx = await ensureContext();
    const buffer = await ctx.decodeAudioData(wav);
    if (gen !== generation) return;
    await new Promise<void>((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => {
        if (current === src) current = null;
        resolve();
      };
      current = src;
      src.start();
    });
  }

  const sender: SpeechSender<VoicevoxConfig> = {
    id: 'voicevox',
    label: 'VOICEVOX',
    config,

    async send(text) {
      const t = text.trim();
      if (!t) return {confirmed: true, detail: '空文のため送信しませんでした'};
      const gen = generation;
      const c = {...sender.config};
      const wav = synthTail.then(() => synthesize(t, c));
      synthTail = wav.catch(() => {});
      playTail = playTail.then(() => wav.then((w) => play(w, gen)).catch((e: unknown) => {
        if (gen !== generation) return;
        console.warn('VOICEVOX 再生失敗', e);
        lastPlayError = e instanceof Error ? e.message : String(e);
      }));
      await wav;
      // 再生は非同期なので、直前の文の再生失敗はこのタイミングで報告する
      const err = lastPlayError;
      lastPlayError = '';
      if (err) throw new Error(`合成はできましたが再生に失敗しました: ${err}`);
      return {confirmed: true, detail: '合成しました（順番に再生します）'};
    },

    // 接続確認に加えて実際に読み上げる（ボタン操作の直後なので再生の許可もここで得られる）
    async test(): Promise<SendResult> {
      const res = await request(sender.config.baseUrl, '/version', {}, 5_000);
      const version = ((await res.json()) as string) || '?';
      const gen = generation;
      const wav = await synthesize('VOICEVOX の接続テストです', {...sender.config});
      await play(wav, gen);
      return {confirmed: true, detail: `VOICEVOX エンジン v${version} で読み上げました`};
    },

    dispose() {
      generation++;
      aborter.abort();
      try {
        current?.stop();
      } catch {
        // 既に停止済み
      }
      current = null;
      void ctx?.close();
      ctx = null;
    },
  };
  return sender;
}
