// 棒読みちゃん（ユーザー PC 上）へ 1 文ずつ読み上げを依頼する。
// http: 標準の HTTP 連携 GET http://localhost:50080/Talk?text=&voice=&volume=&speed=&tone=（プラグイン不要）
//   応答に CORS / CORP ヘッダーが無いため no-cors で投げっぱなしにする。COEP(require-corp) 下では
//   リクエストは届いても応答がブロックされ fetch は失敗扱いになるので、成否は判別できない（confirmed: false）。
// ws: WebSocket プラグイン（xztaityozx/BouyomiChan-WebSocket-Plugin, ws://localhost:50002/）
//   "command<bouyomi>speed<bouyomi>tone<bouyomi>volume<bouyomi>voice<bouyomi>text" を 1 接続 1 メッセージで送る。
//   応答は無いが、接続できたかは分かる。
import type {SendResult, SpeechSender} from './types.ts';

export type BouyomiMode = 'http' | 'ws';

export interface BouyomiConfig {
  mode: BouyomiMode;
  host: string;
  httpPort: number;
  wsPort: number;
  // 0 = 棒読みちゃん側の設定, 1-8 = 女性1/女性2/男性1/男性2/中性/ロボット/機械1/機械2, 10001- = SAPI5 等
  voice: number;
  // -1 = 棒読みちゃん側の設定
  volume: number;
  speed: number;
  tone: number;
}

export const DEFAULT_BOUYOMI_CONFIG: BouyomiConfig = {
  mode: 'http',
  host: 'localhost',
  httpPort: 50080,
  wsPort: 50002,
  voice: 0,
  volume: -1,
  speed: -1,
  tone: -1,
};

// 設定 UI 用（-1 / 0 は「棒読みちゃん側の設定に従う」）
export const BOUYOMI_PARAM_RANGES = {
  volume: {min: 0, max: 100, default: -1},
  speed: {min: 50, max: 300, default: -1},
  tone: {min: 50, max: 200, default: -1},
} as const;

export const BOUYOMI_VOICES: readonly {id: number; name: string}[] = [
  {id: 0, name: '棒読みちゃんの設定'},
  {id: 1, name: '女性1'},
  {id: 2, name: '女性2'},
  {id: 3, name: '男性1'},
  {id: 4, name: '男性2'},
  {id: 5, name: '中性'},
  {id: 6, name: 'ロボット'},
  {id: 7, name: '機械1'},
  {id: 8, name: '機械2'},
];

const HTTP_TIMEOUT_MS = 5_000;
const WS_OPEN_TIMEOUT_MS = 5_000;
// プラグインは受信・処理後に接続を閉じる。閉じられなくてもこの時間で次へ進む
const WS_CLOSE_WAIT_MS = 2_000;
const WS_DELIM = '<bouyomi>';
const WS_COMMAND_TALK = 0x0001;

function hostOf(c: BouyomiConfig): string {
  const h = c.host.trim() || DEFAULT_BOUYOMI_CONFIG.host;
  // IPv6 アドレスは [] で囲む
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

function talkUrl(text: string, c: BouyomiConfig): string {
  const q = new URLSearchParams({
    text,
    voice: String(c.voice),
    volume: String(c.volume),
    speed: String(c.speed),
    tone: String(c.tone),
  });
  return `http://${hostOf(c)}:${c.httpPort}/Talk?${q}`;
}

async function sendHttp(text: string, c: BouyomiConfig, signal: AbortSignal): Promise<SendResult> {
  const url = talkUrl(text, c);
  try {
    await fetch(url, {
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]),
    });
    // 不透明レスポンスでも返ってきた = HTTP サーバーは応答した
    return {confirmed: true, detail: '棒読みちゃんの HTTP 連携に送信しました'};
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new Error(`棒読みちゃんが応答しません（${HTTP_TIMEOUT_MS / 1000} 秒でタイムアウト）: http://${hostOf(c)}:${c.httpPort}/`);
    }
    // 未起動・LNA 拒否と、COEP による応答ブロック（実際は届いている）が区別できない
    return {
      confirmed: false,
      detail: '送信済み（ブラウザの制限で応答は確認できません）',
    };
  }
}

function sendWs(text: string, c: BouyomiConfig, signal: AbortSignal, track: (ws: WebSocket | null) => void): Promise<SendResult> {
  const url = `ws://${hostOf(c)}:${c.wsPort}/`;
  const payload = [WS_COMMAND_TALK, c.speed, c.tone, c.volume, c.voice, text].join(WS_DELIM);
  return new Promise<SendResult>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(new Error(`棒読みちゃんの WebSocket 接続先が不正です（${url}）: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    track(ws);
    let sent = false;
    let timer = 0;
    const finish = (result: SendResult | Error): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      ws.onopen = ws.onerror = ws.onclose = null;
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
      track(null);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onAbort = (): void => finish(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort);
    const done = (): void => finish({confirmed: true, detail: '棒読みちゃんの WebSocket プラグインに送信しました'});
    const fail = (): void => finish(new Error(
      `棒読みちゃんの WebSocket プラグインに接続できません（${url}）。` +
        '棒読みちゃんが起動しているか、Plugin_WebSocket.dll を導入して「WebSocketサーバー」を有効にしたかを確認してください。',
    ));
    timer = window.setTimeout(fail, WS_OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      ws.send(payload);
      sent = true;
      clearTimeout(timer);
      timer = window.setTimeout(done, WS_CLOSE_WAIT_MS);
    };
    // プラグインは close フレームを送らずに切断するので、送信後のエラー / 切断は正常終了扱い
    ws.onerror = () => (sent ? done() : fail());
    ws.onclose = () => (sent ? done() : fail());
  });
}

export function createBouyomiSender(config: BouyomiConfig): SpeechSender<BouyomiConfig> {
  // 棒読みちゃん側に届く順番を保つため直列に送る
  let tail: Promise<unknown> = Promise.resolve();
  let socket: WebSocket | null = null;
  const aborter = new AbortController();

  function enqueue(text: string): Promise<SendResult> {
    const c = {...sender.config};
    const run = tail.then(() => {
      if (aborter.signal.aborted) throw new Error('送信を中止しました');
      return c.mode === 'ws'
        ? sendWs(text, c, aborter.signal, (ws) => (socket = ws))
        : sendHttp(text, c, aborter.signal);
    });
    tail = run.catch(() => {});
    return run;
  }

  const sender: SpeechSender<BouyomiConfig> = {
    id: 'bouyomi',
    label: '棒読みちゃん',
    config,

    async send(text) {
      const t = text.trim();
      if (!t) return {confirmed: true, detail: '空文のため送信しませんでした'};
      return enqueue(t);
    },

    async test(): Promise<SendResult> {
      const r = await enqueue('棒読みちゃん連携のテストです');
      if (r.confirmed) return {confirmed: true, detail: `${r.detail}。読み上げられれば成功です`};
      return {
        confirmed: false,
        detail: 'テスト文を送りました。棒読みちゃんが読み上げれば成功です（HTTP 方式はブラウザの制約で応答を確認できません）',
      };
    },

    dispose() {
      aborter.abort();
      socket?.close();
      socket = null;
    },
  };
  return sender;
}
