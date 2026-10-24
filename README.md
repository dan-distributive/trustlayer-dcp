# TrustLayer on DCP

Speech-deepfake scoring on the DCP network. It takes the QMIND Camp TrustLayer
project (NAVER's pretrained AASIST detector, PyTorch) and runs it as a DCP job:
the model is converted to ONNX, and each worker decodes, resamples, windows,
adds noise and runs inference. The client only packs files.

Read `LESSONS.md` for what was found along the way and `PLAN.md` for the design.

## Layout

| Path | What |
| --- | --- |
| `TrustLayer-Camp-QMIND-MVP/` | upstream clone (unmodified) |
| `models/aasist.onnx` | exported model, 1.63 MB, opset 17, `waveform [n, 64600]` -> `logits [n, 2]` = `[synthetic, genuine]` |
| `tools/export_onnx.py` | PyTorch -> ONNX export + parity check (32 windows, native ORT) |
| `tools/make_test_audio.py` | format variants (WAV/FLAC, 16/24-bit, stereo, 22.05/44.1 kHz, spliced clip) + Python reference margins |
| `tools/smoke_web.js` | headless Chrome test of the web app (runs the work function in the tab) |
| `jobs/aasist-work.js` | **the work function**: self-contained, requires only `onnxruntime-dcp/dcp-wasm.js` + `dcp-ort.js` |
| `jobs/local-harness.js` | runs the work function the way the sandbox does, no DCP |
| `jobs/run.js` | Node dispatcher (files or folders -> DCP job -> CSV + JSONL) |
| `web/` | browser app that deploys the job (symlinks to the work function, model and test clips) |
| `test-audio/` | fixtures + `reference.json` |
| `results/` | run outputs |
| `deck/` | explainer deck and its generator |

## Run it

```bash
git clone --recurse-submodules https://github.com/dan-distributive/trustlayer-dcp

# one-time: Python env for export/reference only (not needed at run time)
python3.12 -m venv .venv && .venv/bin/pip install torch==2.5.1 onnx onnxruntime onnxscript numpy==2.1.3 scipy==1.14.1 soundfile==0.13.1
.venv/bin/python tools/export_onnx.py
.venv/bin/python -I tools/make_test_audio.py

# local, no DCP: must match the Python reference to ~1e-6
node jobs/local-harness.js --check test-audio/reference.json test-audio/*.wav test-audio/*.flac

# real DCP (local worker is in meru)
node jobs/run.js --group <joinKey>:<joinSecret> --snrs null,20,10,0 test-audio/genuine_?.wav test-audio/synthetic_?.wav
# ASVspoof-style corpus with labels from the protocol file
node jobs/run.js --group <joinKey>:<joinSecret> --protocol ASVspoof2019.LA.cm.eval.trl.txt --per-slice 16 LA/ASVspoof2019_LA_eval/flac

# web app: serve web/ itself (fetch() fails under file://)
cd web && python3 -m http.server 8000     # open http://localhost:8000/
node tools/smoke_web.js                   # headless check
```

To deploy the web app to a static host, copy with symlinks resolved:
`rsync -aL web/ host:/var/www/dcp.network/trustlayer/`.

## Job layout

- **Input set:** one slice = K raw files, `{ items: [{ id, name, label, b64 }] }`.
- **Static arguments:** `modelB64`, `plan { snrs, seeds, hop, maxWindows }`, `options { ep, batch, aggregate }`.
- **Work function:** WAV/FLAC decode -> mono -> resample to 16 kHz (scipy `resample_poly` equivalent)
  -> 4.04 s windows with hop -> seeded white noise per (file, window, SNR, seed) -> batched ORT
  -> per-window margins + per-file verdict (lowest margin by default).

## Credits

- Detector: AASIST, Jee-weon Jung et al., NAVER Clova (ICASSP 2022), MIT licence; weights and model code via the upstream repo.
- Camp project: TrustLayer, QMIND Camp team (Reyan, Jinpeng, Kyle, Daniel, Shreya, Abdullah), advised by Shaina Raza.
  Pulled in as a git submodule at the commit this work was built and tested against.
- Audio: ASVspoof 2019 showcase samples (Yamagishi lab, NII); licence in the upstream `assets/ASVspoof_LICENSE.txt`.
  `test-audio/` holds format variants of those clips.
