# test/fixtures/src/{1..5}.wav（16kHz mono PCM16）を 1.5 秒の無音を挟んで連結し、
# clean.wav と雑音入りの noisy.wav（ピンク寄りノイズ, SNR 約 5dB）を作る。
# 使い方: python -I tools/make-fixtures.py test/fixtures
import array
import math
import random
import sys
import wave
from pathlib import Path

root = Path(sys.argv[1])
rate = 16000
gap = array.array('h', [0] * int(rate * 1.5))

samples = array.array('h')
samples.extend(gap)
for i in range(1, 6):
    with wave.open(str(root / 'src' / f'{i}.wav')) as w:
        assert w.getframerate() == rate and w.getnchannels() == 1 and w.getsampwidth() == 2
        samples.frombytes(w.readframes(w.getnframes()))
    samples.extend(gap)


def write(path: Path, data: array.array) -> None:
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(data.tobytes())


write(root / 'clean.wav', samples)

speech_power = sum(s * s for s in samples if s != 0) / max(1, sum(1 for s in samples if s != 0))
target_noise_rms = math.sqrt(speech_power / (10 ** (5 / 10)))
random.seed(0)
noise = []
b = 0.0
for _ in range(len(samples)):
    b = 0.97 * b + random.gauss(0, 1)
    noise.append(b)
noise_rms = math.sqrt(sum(n * n for n in noise) / len(noise))
scale = target_noise_rms / noise_rms
noisy = array.array('h', (max(-32768, min(32767, int(s + n * scale))) for s, n in zip(samples, noise)))
write(root / 'noisy.wav', noisy)
print(f'{len(samples) / rate:.1f}s written')
