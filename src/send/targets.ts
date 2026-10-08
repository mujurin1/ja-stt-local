// 送信タブに並べる送信先の定義（設定項目と生成関数）。
import {
  BOUYOMI_PARAM_RANGES, BOUYOMI_VOICES, createBouyomiSender, DEFAULT_BOUYOMI_CONFIG, listBouyomiVoices,
} from './bouyomi.ts';
import type {BouyomiConfig} from './bouyomi.ts';
import {
  AUTO_VOICE, BROWSER_TTS_PARAM_RANGES, createBrowserTtsSender, DEFAULT_BROWSER_TTS_CONFIG, listLocalVoices,
} from './browser-tts.ts';
import type {BrowserTtsConfig} from './browser-tts.ts';
import {badge, bold, code, helpBox, helpSection, link} from './help.ts';
import type {TargetDescriptor} from './panel.ts';
import {
  createVoicevoxSender, DEFAULT_VOICEVOX_CONFIG, listVoicevoxSpeakers, VOICEVOX_PARAM_RANGES,
} from './voicevox.ts';
import type {VoicevoxConfig} from './voicevox.ts';

const LNA_NOTE = 'Chrome / Edge で「ローカル ネットワーク上のデバイスへのアクセス」の許可を求められたら「許可」を選んでください';

const bouyomi: TargetDescriptor = {
  id: 'bouyomi',
  label: '棒読みちゃん',
  description: '棒読みちゃんに読み上げさせる',
  renderHelp: () => helpSection(
      ['棒読みちゃん 側の準備'],
      helpBox('info', [
        ['棒読みちゃん（Windows 版）を起動しておいてください'],
        [bold('HTTP 方式'), '：棒読みちゃん標準の HTTP 連携（ポート 50080）を使います'],
        ['起動時に「HTTPサーバを開始できませんでした」と出る場合は、他のアプリがポートを使っていないか確認するか、棒読みちゃんとこの画面のポート番号を揃えてください'],
        ['※ブラウザの制約で応答を読めないため、読み上げられたかは耳で確認してください'],
        ['声の「一覧を取得」で、SAPI5 などを含む棒読みちゃんの声を読み込めます（Ver0.1.11.0 Beta21 以降・HTTP ポートを使用。WebSocket 方式でも同じ）。取得できない場合も標準の声（女性1〜機械2）は選べます'],
        [bold('WebSocket 方式'), '：', code('Plugin_WebSocket.dll'), '（',
         link('https://github.com/xztaityozx/BouyomiChan-WebSocket-Plugin', 'xztaityozx/BouyomiChan-WebSocket-Plugin'),
         '）を棒読みちゃんのフォルダに置き、「その他」タブのプラグインで「WebSocketサーバー」を有効にしてください（ポート 50002 固定）'],
        ['WebSocket 方式は接続の成否を確認できます'],
        [LNA_NOTE],
      ])),
  defaultConfig: {...DEFAULT_BOUYOMI_CONFIG},
  fields: [
    {
      key: 'mode',
      label: '接続方式',
      type: 'select',
      options: [
        {value: 'http', label: 'HTTP 連携（標準・ポート 50080）'},
        {value: 'ws', label: 'WebSocket プラグイン（50002）'},
      ],
    },
    {key: 'host', label: 'ホスト', type: 'text'},
    {key: 'httpPort', label: 'HTTP ポート', type: 'number', min: 1, max: 65535},
    {key: 'wsPort', label: 'WebSocket ポート', type: 'number', min: 1, max: 65535},
    {
      key: 'voice',
      label: '声',
      type: 'select',
      // 取得に失敗したら選択肢は標準の声のまま（SAPI5 等は一覧の取得が必要）
      options: BOUYOMI_VOICES.map((v) => ({value: String(v.id), label: v.name})),
      loadOptions: async (c) => (await listBouyomiVoices({...DEFAULT_BOUYOMI_CONFIG, ...c} as BouyomiConfig))
          .map((v) => ({value: String(v.id), label: v.name})),
    },
    {key: 'speed', label: '速度', type: 'number', ...BOUYOMI_PARAM_RANGES.speed, min: -1, hint: '-1 = 棒読みちゃんの設定'},
    {key: 'tone', label: '音程', type: 'number', ...BOUYOMI_PARAM_RANGES.tone, min: -1, hint: '-1 = 棒読みちゃんの設定'},
    {key: 'volume', label: '音量', type: 'number', ...BOUYOMI_PARAM_RANGES.volume, min: -1, hint: '-1 = 棒読みちゃんの設定'},
  ],
  create: (c) => createBouyomiSender(c as unknown as BouyomiConfig),
};

const voicevox: TargetDescriptor = {
  id: 'voicevox',
  label: 'VOICEVOX',
  description: '合成した音声をこのページで再生',
  // 初期設定ではこのサイトからの接続を拒否されるので、許可の手順を必読として赤枠で先に出す
  renderHelp: () => helpSection(
      ['VOICEVOX 側の準備 ', badge('※ 必読')],
      helpBox('important', [
        [bold('このサイトからの接続を許可する（必須）')],
        ['1. ', link('http://127.0.0.1:50021/setting'), ' を開く'],
        ['2. 「Allow Origin」に ', code(location.origin), ' を追加して保存'],
        ['3. VOICEVOX を再起動'],
      ]),
      helpBox('info', [
        ['VOICEVOX（アプリまたはエンジン）を起動しておいてください（既定: http://127.0.0.1:50021）'],
        ['エンジン単体なら、起動オプション ', code(`--allow_origin ${location.origin}`), ' でも許可できます'],
        [LNA_NOTE],
        ['生成した音声を配信・公開する場合は、キャラクターごとの利用規約に従ってクレジット（例: VOICEVOX:ずんだもん）を表記してください'],
      ])),
  defaultConfig: {...DEFAULT_VOICEVOX_CONFIG},
  fields: [
    {key: 'baseUrl', label: 'エンジンの URL', type: 'text'},
    {
      key: 'speaker',
      label: '話者',
      type: 'select',
      options: [{value: '3', label: 'ずんだもん（ノーマル）'}],
      loadOptions: async (c) => (await listVoicevoxSpeakers(String(c.baseUrl)))
          .map((s) => ({value: String(s.id), label: s.name})),
    },
    {key: 'speedScale', label: '話速', type: 'number', ...VOICEVOX_PARAM_RANGES.speedScale},
    {key: 'pitchScale', label: '音高', type: 'number', ...VOICEVOX_PARAM_RANGES.pitchScale},
    {key: 'intonationScale', label: '抑揚', type: 'number', ...VOICEVOX_PARAM_RANGES.intonationScale},
    {key: 'volumeScale', label: '音量', type: 'number', ...VOICEVOX_PARAM_RANGES.volumeScale},
  ],
  create: (c) => createVoicevoxSender(c as unknown as VoicevoxConfig),
};

const browser: TargetDescriptor = {
  id: 'browser',
  label: 'ブラウザ読み上げ',
  description: 'ブラウザ内蔵の声（端末内の音声合成）で読み上げる',
  renderHelp: () => helpSection(
      ['ブラウザ読み上げについて'],
      helpBox('info', [
        ['準備は不要です。OS に入っている声で、この PC の中だけで読み上げます'],
        ['オンライン音声（Google の声や Microsoft の「Online」の声）は使わず、一覧にも出しません'],
        ['日本語の声が無い場合は、Windows の「設定 → 時刻と言語 → 音声」から日本語の音声を追加してください'],
        ['「自動」は端末内の日本語の声から最初のものを使います'],
      ])),
  defaultConfig: {...DEFAULT_BROWSER_TTS_CONFIG},
  fields: [
    {
      key: 'voice',
      label: '声',
      type: 'select',
      options: [{value: AUTO_VOICE, label: '自動（端末内の日本語の声）'}],
      autoLoad: true,
      loadOptions: async () => [
        {value: AUTO_VOICE, label: '自動（端末内の日本語の声）'},
        ...(await listLocalVoices()).map((v) => ({value: v.voiceURI, label: `${v.name}（${v.lang}）`})),
      ],
    },
    {key: 'rate', label: '速度', type: 'number', ...BROWSER_TTS_PARAM_RANGES.rate},
    {key: 'pitch', label: '高さ', type: 'number', ...BROWSER_TTS_PARAM_RANGES.pitch},
    {key: 'volume', label: '音量', type: 'number', ...BROWSER_TTS_PARAM_RANGES.volume},
  ],
  create: (c) => createBrowserTtsSender(c as unknown as BrowserTtsConfig),
};

export const SEND_TARGETS: TargetDescriptor[] = [browser, bouyomi, voicevox];
