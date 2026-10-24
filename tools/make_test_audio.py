"""Build decoder/resampler test fixtures and Python reference margins.

    .venv/bin/python -I tools/make_test_audio.py

Writes test-audio/*.{wav,flac} (format variants of the repo clips plus one
long clip) and test-audio/reference.json: clean margins per window computed
with the upstream load_audio (soundfile + resample_poly) and native ORT.
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
from scipy.signal import resample_poly

HERE = Path(__file__).resolve().parents[1]
UPSTREAM = HERE / "TrustLayer-Camp-QMIND-MVP" / "TrustLayer"
sys.path.insert(0, str(UPSTREAM))
from detector import WINDOW_SAMPLES as W, load_audio  # noqa: E402

OUT = HERE / "test-audio"
HOP = 16000


def windows(x):
    if len(x) <= W:
        return [0], [np.resize(x, W)]
    starts = list(range(0, len(x) - W + 1, HOP))
    if starts[-1] + W < len(x):
        starts.append(len(x) - W)
    return starts, [x[s:s + W] for s in starts]


def main():
    OUT.mkdir(exist_ok=True)
    src = UPSTREAM / "assets" / "audio"
    made = []
    for wav in sorted(src.glob("*.wav")):
        x, sr = sf.read(wav, dtype="float32")
        stem = wav.stem
        sf.write(OUT / f"{stem}.wav", x, sr, subtype="PCM_16"); made.append(f"{stem}.wav")
        sf.write(OUT / f"{stem}.flac", x, sr, subtype="PCM_16"); made.append(f"{stem}.flac")
    g, sr = sf.read(src / "genuine_1.wav", dtype="float32")
    s, _ = sf.read(src / "synthetic_1.wav", dtype="float32")
    stereo = np.stack([g, g * 0.5 + 0.01 * np.roll(g, 7)], axis=1)
    sf.write(OUT / "genuine_1_stereo24.flac", stereo, sr, subtype="PCM_24"); made.append("genuine_1_stereo24.flac")
    sf.write(OUT / "genuine_1_float.wav", stereo, sr, subtype="FLOAT"); made.append("genuine_1_float.wav")
    for rate in (44100, 22050):
        y = resample_poly(g, rate // 100, sr // 100).astype("float32")
        sf.write(OUT / f"genuine_1_{rate}.wav", y, rate, subtype="PCM_16"); made.append(f"genuine_1_{rate}.wav")
        sf.write(OUT / f"genuine_1_{rate}.flac", y, rate, subtype="PCM_16"); made.append(f"genuine_1_{rate}.flac")
    # genuine speech with a synthetic clip spliced into the middle
    spliced = np.concatenate([g, s, g])
    sf.write(OUT / "spliced_g_s_g.flac", spliced, sr, subtype="PCM_16"); made.append("spliced_g_s_g.flac")

    sess = ort.InferenceSession(str(HERE / "models" / "aasist.onnx"))
    ref = {}
    for name in made:
        x = load_audio(OUT / name)
        starts, wins = windows(x)
        logits = sess.run(None, {"waveform": np.stack(wins).astype(np.float32)})[0]
        ref[name] = {"starts": [s / 16000 for s in starts], "margins": (logits[:, 1] - logits[:, 0]).tolist()}
        print(f"{name:<28} {len(starts)} windows  first margin {ref[name]['margins'][0]:8.3f}")
    (OUT / "reference.json").write_text(json.dumps(ref, indent=1))


if __name__ == "__main__":
    main()
