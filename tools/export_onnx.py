"""Export the pretrained AASIST to ONNX and check parity against PyTorch.

    .venv/bin/python tools/export_onnx.py

Writes models/aasist.onnx (input "waveform" [batch, 64600] float32 at 16 kHz,
output "logits" [batch, 2] as [synthetic, genuine]). Parity runs every clip
in the upstream repo, clean and at 20/10/0 dB, through both runtimes.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch

HERE = Path(__file__).resolve().parents[1]
UPSTREAM = HERE / "TrustLayer-Camp-QMIND-MVP" / "TrustLayer"
sys.path.insert(0, str(UPSTREAM))

from detector import WINDOW_SAMPLES, load_audio, model_window  # noqa: E402
from noise_reference import add_white_noise  # noqa: E402
from vendor.AASIST import Model  # noqa: E402

OUT = HERE / "models" / "aasist.onnx"


class LogitsOnly(torch.nn.Module):
    """AASIST returns (last_hidden, logits); only logits leave the worker."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, waveform):
        return self.model(waveform)[1]


def load_torch():
    config = json.loads((UPSTREAM / "assets/AASIST.conf").read_text())["model_config"]
    model = Model(config).cpu()
    model.load_state_dict(torch.load(UPSTREAM / "assets/AASIST.pth", map_location="cpu", weights_only=True))
    return LogitsOnly(model).eval()


def export(model):
    OUT.parent.mkdir(exist_ok=True)
    dummy = torch.zeros(1, WINDOW_SAMPLES)
    torch.onnx.export(
        model, (dummy,), str(OUT), dynamo=False, opset_version=17,
        input_names=["waveform"], output_names=["logits"],
        dynamic_axes={"waveform": {0: "batch"}, "logits": {0: "batch"}},
    )
    onnx.checker.check_model(str(OUT))
    ops = sorted({n.op_type for n in onnx.load(str(OUT)).graph.node})
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB), ops: {', '.join(ops)}")


def windows():
    manifest = json.loads((UPSTREAM / "assets/manifest.json").read_text())
    for item in manifest:
        clean = model_window(load_audio(UPSTREAM / item["path"]))
        yield item["sample_id"], "original", clean
        for snr in (20, 10, 0):
            yield item["sample_id"], f"snr{snr}", add_white_noise(clean, snr_db=snr, seed=42)


def parity(model, opt_level):
    so = ort.SessionOptions()
    so.graph_optimization_level = opt_level
    so.intra_op_num_threads = 1
    sess = ort.InferenceSession(str(OUT), so, providers=["CPUExecutionProvider"])
    worst, flips, t_ort = 0.0, 0, []
    for sample_id, cond, audio in windows():
        x = audio[None, :].astype(np.float32)
        with torch.inference_mode():
            ref = model(torch.from_numpy(x)).numpy()[0]
        t0 = time.perf_counter()
        got = sess.run(None, {"waveform": x})[0][0]
        t_ort.append(time.perf_counter() - t0)
        worst = max(worst, float(np.abs(ref - got).max()))
        flips += int(np.argmax(ref) != np.argmax(got))
    batch = np.stack([a for _, _, a in windows()]).astype(np.float32)
    with torch.inference_mode():
        ref_b = model(torch.from_numpy(batch)).numpy()
    got_b = sess.run(None, {"waveform": batch})[0]
    print(f"[{opt_level.name}] 32 windows: max |torch-ort| {worst:.2e}, label flips {flips}, "
          f"median ort {np.median(t_ort) * 1000:.0f} ms/window (1 thread); "
          f"batch-32 max diff {np.abs(ref_b - got_b).max():.2e}")


if __name__ == "__main__":
    torch.set_num_threads(1)
    m = load_torch()
    export(m)
    parity(m, ort.GraphOptimizationLevel.ORT_DISABLE_ALL)
    parity(m, ort.GraphOptimizationLevel.ORT_ENABLE_ALL)
