# TrustLayer (AASIST) inference on DCP: plan

Upstream: `TrustLayer-Camp-QMIND-MVP/` (QMIND Camp starter, cloned 2026-10-24).
It wraps NAVER's pretrained AASIST speech-deepfake detector (`vendor/AASIST.py`,
MIT; weights `assets/AASIST.pth`) and tests it on 8 ASVspoof2019 clips, clean
and with white noise at 20/10/0 dB SNR. No training happens anywhere in the repo.

## The model

| | |
| --- | --- |
| Weights (`AASIST.pth`) | 1.28 MB, about 300K parameters |
| ONNX (`models/aasist.onnx`) | 1.63 MB, opset 17, base64 about 2.2 MB |
| Input | `waveform` float32 `[batch, 64600]`: 4.04 s of mono 16 kHz audio |
| Output | `logits` float32 `[batch, 2]` = `[synthetic, genuine]`; upstream labels bonafide=1 |
| Decision | `genuine` if `genuine > synthetic`; `genuine_margin = genuine - synthetic` (raw logits, not a probability) |
| CPU cost | about 0.3 s per window native ORT, about 0.6 s onnxruntime-web wasm (1 thread, M-series) |

The SincConv front end uses a fixed filter bank (`band_pass` is a plain tensor,
not a trained parameter), so it exports as a constant Conv. Graph-pooling
`TopK` sizes are fixed by the 64600-sample input length, so the input length is
static. Only the batch axis is dynamic.

## Conversion: done and verified

`tools/export_onnx.py` (venv at `.venv`, torch 2.5.1 as the repo pins):

- Exports with the TorchScript exporter, opset 17, logits output only.
- Parity on all 32 windows (8 clips x clean/20/10/0 dB): max |torch - ORT| 2.9e-6,
  0 label flips, with graph optimization both off and on. A batch of 32 gives
  the same results.
- onnxruntime-web 1.26.0-dev (wasm, in Node) on `synthetic_1`: logits match
  native to about 1e-6.

Ops used: Abs Add BatchNormalization Cast Concat Constant ConstantOfShape Conv
Div Equal Expand Gather GatherElements Gemm MatMul Max MaxPool Mul Range
ReduceMax ReduceMean Reshape ScatterND Selu Shape Sigmoid Slice Softmax Squeeze
Tanh TopK Transpose Unsqueeze Where. The wasm EP supports all of them.

## Runtime choice: wasm first

Use `onnxruntime-dcp/dcp-ort.js` + `dcp-wasm.js` (published, same as
`~/onnx-inference-dcp`), wasm EP by default. Reasons:

- The model is tiny and convolution-heavy at batch 1. GPU dispatch overhead
  would eat most of any gain.
- `TopK`, `ScatterND` and `GatherElements` may not have WebGPU kernels, so ORT
  would split the graph and copy tensors between GPU and CPU on every run.
- Keep a `webgpu` flag in the options argument (the MNIST example already does
  this) and measure it once wasm works. Avoid workers in `bell` (no WASM SIMD).

## Organizing the job

Principle (revised 2026-10-24): do as much as possible in the sandbox. The
client only reads files and base64-encodes them. That's I/O, a few ms per
file. Decoding, resampling, windowing, noise and inference all run distributed.
Exact match with numpy's noise is not a goal; the aim is the same kind and
amount of work.

**Input set** (one element per slice): a batch of K raw audio files as shipped,
`{ items: [{ id, label?, fmt: 'wav'|'flac'|'mp3', b64 }] }`. Compressed
sources are smaller than float32 windows, so upload drops too. Binary must go
as base64: `RemoteDataSet` text-decodes binary (lossy), and raw `Buffer`
arguments arrive as `{}` (both found in ~/DCP/transformers). For very large
corpora, a small proxy that serves base64-in-JSON lets workers pull their own
data.

**Static arguments** (fetched once per sandbox):
1. `modelB64`: the 2.2 MB ONNX. An argument, so checkpoints can be swapped.
2. `plan`: windowing + conditions, e.g.
   `{ window: 64600, hop: 16000, maxWindows: null, snrs: [null, 20, 10, 0], seeds: [42] }`.
3. `options`: `{ ep: 'wasm' | 'webgpu', aggregate: 'min-margin' }`.

**Work function**, per file:
1. Decode. WAV in plain JS; FLAC (ASVspoof ships FLAC) and MP3 through small
   wasm decoders (minimp3-wasm is already proven in CallRAG; FLAC decoder still
   to be picked).
2. Downmix to mono, resample to 16 kHz (polyphase/windowed-sinc in JS; a no-op
   for ASVspoof, which is already 16 kHz).
3. Slide 64600-sample windows with `hop`, tiling short clips as upstream does.
4. For each condition, add white noise at the target SNR, using a seeded JS RNG
   (xoshiro128 + Box-Muller) seeded from `(fileId, window, seed)`, so any
   worker gives the same result.
5. Run everything as `[n, 64600]` batches on a session cached on `globalThis`.
6. Return per-window margins plus a per-file verdict (lowest margin = most
   synthetic window).

Choose K so a slice runs 10 to 30 s. Work per file grows with
(windows x conditions), so K should come from the plan, not be fixed.

## Steps

1. Done: ONNX export plus parity (native and onnxruntime-web).
2. `jobs/aasist-work.js` + decoders/RNG/resampler as local `job.requires`
   modules. Test with the `new Function('require', ...)` harness from
   `~/DCP/distributed-pipelining/jobs/run-stage-local.js`.
3. `jobs/run.js`: dispatch the 8 repo clips (WAV) to the local worker's group. Check clean
   margins against `results/baseline.csv` (should match closely) and noisy
   margins for the same trend as the team's CSV.
4. Scale: the ASVspoof2019 LA eval set (FLAC, about 71K utterances), or a dense
   SNR x seed sweep.
5. Optional: sliding-window timelines on long clips, a WebGPU timing comparison,
   and a stronger model (below).

## Model choice and partial fakes

- AASIST (2021) was trained only on ASVspoof2019 LA, whose attacks are 2019-era
  TTS/VC systems. Expect weak results on modern TTS and voice cloning. SSL
  front ends (wav2vec 2.0 / XLS-R) with an AASIST-style back end generalize
  much better, at about 300M params (about 1.2 GB fp32, about 300 MB int8):
  feasible on DCP (Qwen 0.5B ran at 512 MB), and a better demo workload.
- AASIST gives one verdict per 4.04 s window and was not trained on partial
  spoofs. Sliding windows give a coarse timeline (about 1 s steps), but a short
  splice inside a mostly genuine window may not flip it. PartialSpoof-style
  models (SSL front end, frame-level output at about 20 ms) are the right tool
  for localizing inserted fake segments.

## Caveats carried from upstream

- The model only sees the first 4.04 s of each clip; shorter clips are tiled.
  Long real-world audio needs a windowing and aggregation policy (max, mean of
  margins) that upstream doesn't define.
- 8 hand-picked showcase clips say nothing about real-world accuracy (the
  upstream README says so too).
- Upstream `HtrgGAT` calls pass `self.master1` rather than the expanded tensor.
  It broadcasts correctly, and the batch-32 parity confirms that.
