import {nativeAsrSupported} from './engine/native-asr.ts';
import {DEFAULT_MODEL_ID, FALLBACK_MODEL_ID, MODELS} from './shared/models.ts';
import type {AsrSettings} from './shared/protocol.ts';

export interface AppSettings {
  modelId: string;
  deviceId: string;
  browserNoiseSuppression: boolean;
  browserEchoCancellation: boolean;
  browserAutoGain: boolean;
  gtcrn: boolean;
  showTimestamps: boolean;
  asr: AsrSettings;
}

const STORAGE_KEY = 'stt-settings-v1';

export function defaultThreads(): number {
  return Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
}

export function defaultSettings(): AppSettings {
  return {
    modelId: nativeAsrSupported() ? DEFAULT_MODEL_ID : FALLBACK_MODEL_ID,
    deviceId: '',
    // ノイズ対策はどのモデルでも認識精度を下げがちなので既定はすべて OFF
    browserNoiseSuppression: false,
    browserEchoCancellation: false,
    browserAutoGain: false,
    gtcrn: false,
    showTimestamps: true,
    asr: {
      vadThreshold: 0.5,
      minSilenceSec: 0.5,
      minSpeechSec: 0.25,
      maxSpeechSec: 15,
      partialIntervalMs: 500,
      numThreads: defaultThreads(),
    },
  };
}

export function hasSavedSettings(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

export function loadSettings(): AppSettings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<AppSettings>;
    const merged: AppSettings = {...d, ...s, asr: {...d.asr, ...s.asr}};
    if (!MODELS.some((m) => m.id === merged.modelId)) merged.modelId = d.modelId;
    return merged;
  } catch {
    return d;
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
