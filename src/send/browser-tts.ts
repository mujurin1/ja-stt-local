// ブラウザ内蔵の読み上げ（Web Speech API の speechSynthesis）。
// 端末内で合成する声（localService）だけを使い、オンライン音声には送らない。
// 声を指定しないとブラウザがオンライン音声を選ぶことがあるので、必ず端末内の声を明示する。
import type {SendResult, SpeechSender} from './types.ts';

export interface BrowserTtsConfig {
  // SpeechSynthesisVoice.voiceURI。AUTO_VOICE なら端末内の日本語の声を自動で選ぶ
  voice: string;
  rate: number;
  pitch: number;
  volume: number;
}

export const AUTO_VOICE = 'auto';

export const DEFAULT_BROWSER_TTS_CONFIG: BrowserTtsConfig = {
  voice: AUTO_VOICE,
  rate: 1,
  pitch: 1,
  volume: 1,
};

export const BROWSER_TTS_PARAM_RANGES = {
  rate: {min: 0.5, max: 2, step: 0.1},
  pitch: {min: 0, max: 2, step: 0.1},
  volume: {min: 0, max: 1, step: 0.1},
} as const;

const VOICES_TIMEOUT_MS = 2_000;

function isJa(v: SpeechSynthesisVoice): boolean {
  return v.lang.toLowerCase().startsWith('ja');
}

// 端末内の声を日本語優先で返す。getVoices() は初回だと空のことがあるので voiceschanged を少し待つ
export async function listLocalVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!('speechSynthesis' in window)) return [];
  let voices = speechSynthesis.getVoices();
  if (voices.length === 0) {
    voices = await new Promise((resolve) => {
      const done = () => {
        speechSynthesis.removeEventListener('voiceschanged', done);
        resolve(speechSynthesis.getVoices());
      };
      speechSynthesis.addEventListener('voiceschanged', done);
      setTimeout(done, VOICES_TIMEOUT_MS);
    });
  }
  const local = voices.filter((v) => v.localService);
  return [...local.filter(isJa), ...local.filter((v) => !isJa(v))];
}

async function pickVoice(c: BrowserTtsConfig): Promise<SpeechSynthesisVoice> {
  const voices = await listLocalVoices();
  const chosen = c.voice === AUTO_VOICE ? voices.find(isJa) : voices.find((v) => v.voiceURI === c.voice);
  if (chosen) return chosen;
  if (c.voice !== AUTO_VOICE) throw new Error('選んだ声が見つかりません。声の一覧を取得し直してください');
  throw new Error('端末内の日本語の声が見つかりません（OS に日本語の音声を追加してください）');
}

export function createBrowserTtsSender(config: BrowserTtsConfig): SpeechSender<BrowserTtsConfig> {
  let lastError = '';
  let disposed = false;

  function utter(text: string, voice: SpeechSynthesisVoice, c: BrowserTtsConfig): Promise<void> {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = c.rate;
    u.pitch = c.pitch;
    u.volume = c.volume;
    return new Promise((resolve, reject) => {
      u.onend = () => resolve();
      u.onerror = (e) => {
        // cancel() による中断はエラー扱いしない
        if (e.error === 'canceled' || e.error === 'interrupted') resolve();
        else reject(new Error(`読み上げに失敗しました: ${e.error}`));
      };
      speechSynthesis.speak(u);
    });
  }

  const sender: SpeechSender<BrowserTtsConfig> = {
    id: 'browser',
    label: 'ブラウザ読み上げ',
    config,

    // speechSynthesis 自体が順番に読むので、積んだ時点で返す。読み上げ中の失敗は次の送信で報告する
    async send(text) {
      const t = text.trim();
      if (!t) return {confirmed: true, detail: '空文のため送信しませんでした'};
      const err = lastError;
      lastError = '';
      const voice = await pickVoice(sender.config);
      if (disposed) return {confirmed: false, detail: '停止済み'};
      utter(t, voice, sender.config).catch((e: unknown) => {
        lastError = e instanceof Error ? e.message : String(e);
      });
      if (err) throw new Error(`直前の文で${err}`);
      return {confirmed: true, detail: `${voice.name} で読み上げます`};
    },

    async test(): Promise<SendResult> {
      const voice = await pickVoice(sender.config);
      await utter('ブラウザ読み上げのテストです', voice, sender.config);
      return {confirmed: true, detail: `${voice.name} で読み上げました`};
    },

    dispose() {
      disposed = true;
      speechSynthesis.cancel();
    },
  };
  return sender;
}
