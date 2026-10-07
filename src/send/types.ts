// 確定した認識結果を外部の読み上げアプリ（棒読みちゃん / VOICEVOX）へ送るための共通インターフェース。
// 各送信先は src/send/<id>.ts に実装し、画面（送信タブ）からはこの型だけを通して使う。

export type SenderId = 'bouyomi' | 'voicevox';

export interface SendResult {
  // 送信先から応答を確認できたか。no-cors 等で応答を読めない場合は false（送れてはいる可能性がある）
  confirmed: boolean;
  detail?: string;
}

export interface SpeechSender<Config> {
  readonly id: SenderId;
  readonly label: string;
  config: Config;
  // 1 文を送る。送れなかったことが判別できた場合は Error を投げる
  send(text: string): Promise<SendResult>;
  // 接続確認（設定画面の「テスト」ボタン用）。短い説明文を返す
  test(): Promise<SendResult>;
  dispose(): void;
}
