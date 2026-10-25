# TrustLayer on DCP

Speech-deepfake scoring on the DCP network. It takes the QMIND Camp TrustLayer
project (NAVER's pretrained AASIST detector, PyTorch) and runs it as a DCP job:
the model is converted to ONNX, and each worker decodes, resamples, windows,
adds noise and runs inference. The client only packs files.

Read `LESSONS.md` for what was found along the way and `PLAN.md` for the design.

## Two launchers, each standalone

The web app and the Node dispatcher are separate front ends to the same job. Each works
on its own; neither needs the other, and neither needs Python. Both send the same work
function (`jobs/aasist-work.js`) and model (`models/aasist.onnx`), so their results agree.

| | Web app (`web/`) | Node dispatcher (`jobs/run.js`) |
| --- | --- | --- |
| For | anyone, in a browser | scripted or large runs (whole corpora, sweeps) |
| Hosted at | https://dcp.dev/projects/trustlayer/ | your machine |
| Needs | nothing to install; static files only (no build, no server code) | Node 18+, `npm install` (dcp-client) |
| Identity and payment | API key field and the DCP wallet picker | `~/.dcp/id.keystore` + `default.keystore`, or `DCP_IDENTITY_KEY` |
| Compute group | prefilled `queens`; secret typed once, kept in the browser | `--group`, `DCP_GROUP`, or gitignored `config.local.json` |
| Input | files dropped on the page | files or folders on disk, optional ASVspoof protocol for labels |
| Output | tables and timelines on the page, CSV/JSON download | `results/<name>.csv` + `.jsonl` |
| Bring workers | QR code beside the log opens dcp.live in the first compute group | point workers at the group yourself |
| Try without DCP | (none; use the Node harness) | `jobs/local-harness.js` |

`web/` holds symlinks to the work function, the model, the test clips and the deck PDF, so
it is complete as a folder. To publish, copy it with symlinks resolved (`-L`) and only the
10 sample clips the page loads (15 files, about 3 MB):

```bash
rsync -avzL \
  --include='samples/' \
  --include='samples/genuine_?.wav' --include='samples/synthetic_?.wav' \
  --include='samples/spliced_g_s_g.flac' --include='samples/genuine_1_44100.flac' \
  --exclude='samples/*' \
  web/ people:~/public_html/trustlayer/
```

## Layout

| Path | What |
| --- | --- |
| `TrustLayer-Camp-QMIND-MVP/` | upstream clone (unmodified) |
| `models/aasist.onnx` | exported model, 1.63 MB, opset 17, `waveform [n, 64600]` -> `logits [n, 2]` = `[synthetic, genuine]` |
| `tools/export_onnx.py` | PyTorch -> ONNX export + parity check (32 windows, native ORT) |
| `tools/make_test_audio.py` | format variants (WAV/FLAC, 16/24-bit, stereo, 22.05/44.1 kHz, spliced clip) + Python reference margins |
| `tools/smoke_web.js` | headless Chrome test of the web app (page load, sample clips, worker QR links) |
| `jobs/aasist-work.js` | **the work function**: self-contained, requires only `onnxruntime-dcp/dcp-wasm.js` + `dcp-ort.js` |
| `jobs/local-harness.js` | runs the work function the way the sandbox does, no DCP |
| `jobs/run.js` | Node dispatcher (files or folders -> DCP job -> CSV + JSONL) |
| `web/` | browser app that deploys the job (symlinks to the work function, model, test clips, deck PDF) |
| `test-audio/` | fixtures + `reference.json` |
| `results/` | run outputs |
| `deck/` | explainer deck (.pptx, .pdf) and its generator |

## Run it

```bash
git clone --recurse-submodules https://github.com/dan-distributive/trustlayer-dcp
cd trustlayer-dcp && npm install        # dcp-client (dispatcher), onnxruntime-web (local harness)

# optional, one-time: Python env to re-export the model or rebuild the reference (not needed to run anything)
python3.12 -m venv .venv && .venv/bin/pip install torch==2.5.1 onnx onnxruntime onnxscript numpy==2.1.3 scipy==1.14.1 soundfile==0.13.1
.venv/bin/python tools/export_onnx.py
.venv/bin/python -I tools/make_test_audio.py

# local, no DCP: must match the Python reference to ~1e-6
npm run harness

# real DCP. Default compute group comes from the gitignored config.local.json
# ({"group": "queens:<joinSecret>"}) or DCP_GROUP; --group overrides. Never commit a secret.
node jobs/run.js --snrs null,20,10,0 test-audio/genuine_?.wav test-audio/synthetic_?.wav
# ASVspoof-style corpus with labels from the protocol file
node jobs/run.js --protocol ASVspoof2019.LA.cm.eval.trl.txt --per-slice 16 LA/ASVspoof2019_LA_eval/flac

# web app, local copy for development (the public one is at dcp.dev/projects/trustlayer)
cd web && python3 -m http.server 8000     # http://localhost:8000/ ; fetch() fails under file://
npm run smoke-web                         # headless check
```

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
