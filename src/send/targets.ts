// 送信タブに並べる送信先の定義（設定項目と生成関数）。
import {
  BOUYOMI_PARAM_RANGES, BOUYOMI_SETUP_HELP, BOUYOMI_VOICES, createBouyomiSender, DEFAULT_BOUYOMI_CONFIG,
} from './bouyomi.ts';
import type {BouyomiConfig} from './bouyomi.ts';
import type {TargetDescriptor} from './panel.ts';
import {
  createVoicevoxSender, DEFAULT_VOICEVOX_CONFIG, listVoicevoxSpeakers, VOICEVOX_PARAM_RANGES,
  VOICEVOX_SETUP_HELP,
} from './voicevox.ts';
import type {VoicevoxConfig} from './voicevox.ts';

const bouyomi: TargetDescriptor = {
  id: 'bouyomi',
  label: '棒読みちゃん',
  description: '棒読みちゃんに読み上げさせる',
  help: BOUYOMI_SETUP_HELP,
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
      options: BOUYOMI_VOICES.map((v) => ({value: String(v.id), label: v.name})),
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
  help: VOICEVOX_SETUP_HELP,
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

export const SEND_TARGETS: TargetDescriptor[] = [bouyomi, voicevox];
