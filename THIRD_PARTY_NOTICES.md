# Third-party notices

このアプリ自体のコードは [MIT License](LICENSE) です。
リポジトリおよび公開サイトには、以下の第三者のソフトウェア・モデルを同梱しています。
各ライセンス全文は [`public/licenses/`](public/licenses/)（公開サイトでは `licenses/`）にあります。

| 名称 | 同梱場所 | ライセンス | 著作権者 | 改変 |
|---|---|---|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（WebAssembly ビルド v1.13.2 / v1.13.8） | `public/vendor/sherpa-asr/`, `public/vendor/sherpa-denoise/` | Apache-2.0（[全文](public/licenses/sherpa-onnx.LICENSE.txt)） | Xiaomi Corporation and the sherpa-onnx contributors | あり（下記） |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime)（sherpa-onnx の WASM に静的リンク） | 同上の `.wasm` | MIT（[全文](public/licenses/onnxruntime.LICENSE.txt)） | Microsoft Corporation | なし |
| [Silero VAD](https://github.com/snakers4/silero-vad) モデル | `public/vendor/sherpa-asr/silero_vad.onnx` | MIT（[全文](public/licenses/silero-vad.LICENSE.txt)） | Silero Team | なし |
| [GTCRN](https://github.com/Xiaobin-Rong/gtcrn) モデル | `public/vendor/sherpa-denoise/*.data` 内の `gtcrn.onnx` | MIT（[全文](public/licenses/gtcrn.LICENSE.txt)） | Rong Xiaobin | なし |
| [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) v0.1.7 | `public/coi-serviceworker.js` | MIT（[全文](public/licenses/coi-serviceworker.LICENSE.txt)） | Guido Zuidhof | あり（下記） |

## 改変内容

- **sherpa-onnx**: GitHub Releases の配布物 `sherpa-onnx-wasm-simd-1.13.2-vad-asr-ja-zipformer_reazonspeech` から、
  - `sherpa-onnx-wasm-main-vad-asr.js` 内の、モデルを焼き込んだ `.data` を読み込む `loadPackage(...)` 呼び出しを削除（モデルを実行時に取得するため）
  - 同 `.data` から `silero_vad.onnx` のみを切り出して同梱
  - 処理は [`tools/setup-vendor.ts`](tools/setup-vendor.ts) にあります。`sherpa-onnx-wasm-simd-v1.13.8-speech-enhancement-gtcrn` は無改変です。
- **coi-serviceworker**: localhost / 127.0.0.1 / [::1] 宛てのリクエストを Service Worker で横取りしない処理を追加（同じく `tools/setup-vendor.ts`）。

## 同梱していないもの

- **音声認識モデル**（ReazonSpeech / SenseVoice / Parakeet / Moonshine）は同梱しておらず、利用者のブラウザが Hugging Face から直接取得します。各モデルのライセンスは画面のモデル一覧に表示しています。Moonshine の日本語モデルは Moonshine Community License（非商用）です。
- **VOICEVOX** で生成した音声は、各キャラクターの利用規約に従ってください（公開する場合は「VOICEVOX:ずんだもん」等のクレジット表記が必要です）。
- **棒読みちゃん** は外部アプリとして呼び出すのみです。
