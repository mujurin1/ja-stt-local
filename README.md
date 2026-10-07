# ブラウザで動くローカル音声認識

https://mujurin1.github.io/ja-stt-local/

インストール不要、ブラウザだけで動く日本語のリアルタイム音声認識です。音声は外部に送信されず、この PC の中だけで文字になります。

- リアルタイム認識（途中結果つき）と、音声・動画ファイルの文字起こし（TXT / SRT / VTT / JSON 書き出し）
- モデルを選んで切り替え・事前ダウンロード・削除（ReazonSpeech / SenseVoice / Parakeet / Moonshine）
- ノイズ対策（ブラウザのノイズ抑制、GTCRN）
- 認識結果を棒読みちゃん・VOICEVOX で読み上げ

## しくみ

- 認識エンジン: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) の WebAssembly ビルド（`public/vendor`）+ Silero VAD
- モデルは初回利用時に Hugging Face から取得し、ブラウザの Cache Storage に保存
- VAD で区切った発話を認識し、発話中は一定間隔で再認識して途中結果を出す（擬似ストリーミング）
- pthreads 版 WASM のため cross-origin isolation が必要。ヘッダーを設定できないホスティング向けに `coi-serviceworker` を同梱（localhost 宛ては素通しするパッチ入り）

## 開発

```sh
pnpm install
pnpm vendor     # sherpa-onnx の WASM を取得して public/vendor に配置（同梱済みなので通常は不要）
pnpm dev
pnpm build      # 型チェック（tsgo）+ Vite で dist/ に単一 HTML を出力
```

`main` に push すると GitHub Actions がビルドして GitHub Pages に公開します（`.github/workflows/pages.yml`）。

動作確認: `pnpm build && pnpm preview` の後に `node tools/e2e.ts`（テスト音声は `python -I tools/make-fixtures.py test/fixtures` で生成）。

## 読み上げ連携の準備

- 棒読みちゃん: 起動しておくだけ（HTTP 連携 / ポート 50080）。Windows がポートを予約していて起動に失敗する場合は、棒読みちゃん側のポートを変えて画面の設定も合わせる
- VOICEVOX: `http://127.0.0.1:50021/setting` の Allow Origin に公開先のオリジンを追加して再起動
- Chrome で「ローカル ネットワーク上のデバイスへのアクセス」を求められたら許可

## ライセンス

コード: MIT（[LICENSE](LICENSE)）。

同梱している第三者のソフトウェア・モデル（sherpa-onnx: Apache-2.0、ONNX Runtime / Silero VAD / GTCRN / coi-serviceworker: MIT）と改変内容は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

- 音声認識モデルは同梱せず、利用者のブラウザが Hugging Face から取得します。各モデルのライセンスは画面に表示しています。Moonshine の日本語モデルは**非商用**ライセンスです。
- VOICEVOX で生成した音声を公開する場合は、各キャラクターの利用規約に従ってクレジット（例: 「VOICEVOX:ずんだもん」）を表記してください。
