// ブラウザ標準の音声認識（Web Speech API）を端末内処理（processLocally, Chrome では SODA）で使う。
// 既定のクラウド認識だと音声が外部に送られるので、端末内で使えない環境は非対応として扱う。
// 言語パックはブラウザが管理し、無ければ install() で取得させる。
// 無音などで勝手に終わるので、録音中は自動で再開し続ける。
import type {Segment} from '../shared/protocol.ts';

const LANG = 'ja-JP';

// lib.dom に結果系の型はあるが、本体（コンストラクタ）が無いので最小限だけ宣言する
interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type NativeStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface LocalOptions {
  langs: string[];
  processLocally: boolean;
}

interface RecognitionCtor {
  new(): Recognition;
  available?(options: LocalOptions): Promise<NativeStatus>;
  install?(options: LocalOptions): Promise<boolean>;
}

const LOCAL: LocalOptions = {langs: [LANG], processLocally: true};

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as {SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor};
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

// 端末内認識の API があるか（言語パックの有無までは分からない。既定モデルの判定用）
export function nativeAsrSupported(): boolean {
  return typeof recognitionCtor()?.available === 'function';
}

export async function nativeStatus(): Promise<NativeStatus> {
  const Ctor = recognitionCtor();
  if (!Ctor?.available) return 'unavailable';
  try {
    return await Ctor.available(LOCAL);
  } catch {
    return 'unavailable';
  }
}

// 日本語の言語パックを取得させる。成功したら true
export async function installNative(): Promise<boolean> {
  const Ctor = recognitionCtor();
  if (!Ctor?.install) return false;
  try {
    return await Ctor.install(LOCAL);
  } catch {
    return false;
  }
}

export interface NativeAsrHooks {
  onPartial(text: string): void;
  onFinal(segment: Segment): void;
  // 録音を続けられない（マイク拒否など）。呼ばれた時点で停止済み
  onFatal(message: string): void;
}

const FATAL_ERRORS: Record<string, string> = {
  'not-allowed': 'マイクまたは音声認識の利用が許可されていません',
  'service-not-allowed': 'このブラウザでは音声認識サービスを利用できません',
  'language-not-supported': '日本語の端末内音声認識が使えません（言語パック未取得の可能性があります）',
  'audio-capture': 'マイクを取得できません',
};

export class NativeAsr {
  hooks: NativeAsrHooks;
  rec: Recognition | null = null;
  running = false;
  // 録音開始からの経過秒の起点
  t0 = 0;
  // 確定前の発話が始まった時刻（秒）。途中結果が出始めた時点で記録する
  utteranceStart: number | null = null;
  // 連続エラー時に再開間隔を伸ばす
  failures = 0;
  ended: (() => void) | null = null;

  constructor(hooks: NativeAsrHooks) {
    this.hooks = hooks;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.t0 = performance.now();
    this.utteranceStart = null;
    this.failures = 0;
    this.open();
  }

  // 認識中の発話を確定させてから止める
  stop(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.running = false;
    const rec = this.rec;
    if (!rec) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        rec.abort();
        this.finish();
        resolve();
      }, 3000);
      this.ended = () => {
        clearTimeout(timer);
        resolve();
      };
      rec.stop();
    });
  }

  private now(): number {
    return (performance.now() - this.t0) / 1000;
  }

  private open(): void {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.running = false;
      this.hooks.onFatal('このブラウザは音声認識に対応していません');
      return;
    }
    const rec = new Ctor();
    rec.lang = LANG;
    rec.processLocally = true;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => this.handleResult(ev);
    rec.onerror = (ev) => {
      const fatal = FATAL_ERRORS[ev.error];
      if (fatal) {
        this.running = false;
        this.hooks.onFatal(fatal);
      } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
        this.failures++;
        console.warn('native asr:', ev.error, ev.message);
      }
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.finish();
      if (this.running) {
        const delay = Math.min(5000, this.failures * 500);
        setTimeout(() => this.running && !this.rec && this.open(), delay);
      }
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (e) {
      this.rec = null;
      this.running = false;
      this.hooks.onFatal(String(e));
    }
  }

  // セッション終了。確定しないまま残った途中結果は捨てる
  private finish(): void {
    this.rec = null;
    this.utteranceStart = null;
    this.hooks.onPartial('');
    const ended = this.ended;
    this.ended = null;
    ended?.();
  }

  private handleResult(ev: SpeechRecognitionEvent): void {
    this.failures = 0;
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i]!;
      const text = result[0]?.transcript.trim() ?? '';
      if (!text) continue;
      this.utteranceStart ??= this.now();
      if (result.isFinal) {
        this.hooks.onPartial('');
        this.hooks.onFinal({start: this.utteranceStart, end: this.now(), text});
        this.utteranceStart = null;
      } else {
        interim += text;
      }
    }
    this.hooks.onPartial(interim);
  }
}
