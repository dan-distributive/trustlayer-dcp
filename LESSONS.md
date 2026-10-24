# Lessons learned: TrustLayer (AASIST) on DCP

Running log, newest at the bottom. Each entry: what was tried, what happened, what it means.

## 2026-10-24: the upstream project

- QMIND Camp starter around NAVER's pretrained AASIST (`vendor/AASIST.py`, MIT; weights
  1.28 MB, about 300K params). No training anywhere. Eight showcase clips from the
  ASVspoof2019 samples page (4 bona fide, 4 spoof), clean plus white noise at 20/10/0 dB.
- The detector looks at **one** 64600-sample window (4.04 s at 16 kHz), and upstream only
  scores the first one: longer clips are cut, shorter clips are tiled.
- Output is two raw logits, `[synthetic, genuine]` (upstream labels bonafide=1). The team
  reports `genuine_margin = genuine - synthetic`, not a probability.

## 2026-10-24: ONNX conversion

- TorchScript exporter, opset 17, dynamic batch axis only. It went through first time: the
  SincConv filter bank is a plain tensor (exports as a constant Conv), the graph-pool `TopK`
  sizes are fixed by the input length, and dropout is a no-op in eval.
- Parity on 32 windows: max |torch - ORT| 2.9e-6, no label flips, with graph optimization on
  or off, at batch 1 and batch 32. onnxruntime-web 1.26 wasm in Node matches native to 1e-6.
- 1.63 MB ONNX, about 2.2 MB base64: small enough to send as a job argument, which keeps
  checkpoints swappable without touching code.

## 2026-10-24: design change, push the work into the sandbox (Dan)

- First plan decoded and windowed client-side. Dan's correction: over a big corpus, that is a
  serial bottleneck on one machine, so all of it goes in the work function. The client only
  reads files and base64-encodes them (and compressed FLAC is smaller than float32 windows
  anyway, so upload shrinks too).
- Matching numpy's seeded noise exactly is not a goal; "effective workload parity" is.
  The worker uses xoshiro128** + Box-Muller seeded by FNV-1a of `name|windowStart|snr|seed`,
  so any worker produces the same noise for the same work.
- Browser dispatch rules out local `job.requires()` (that path runs webpack, Node only, see
  3KIDNAS). So the work function is one self-contained function; its only requires are the
  published `onnxruntime-dcp/dcp-wasm.js` and `dcp-ort.js`.

## 2026-10-24: decoders and resampler written in-sandbox JS

- WAV: PCM 8/16/24/32 and float 32/64, WAVE_FORMAT_EXTENSIBLE. FLAC: full decoder (constant,
  verbatim, fixed, LPC subframes; rice and escape residuals; wasted bits; left/side,
  side/right, mid/side). Resampler: scipy `resample_poly` reimplemented (Kaiser beta 5,
  half length 10*max(up, down), delay-compensated).
- Tested end to end instead of unit by unit: 23 fixtures (WAV and FLAC, 16- and 24-bit,
  stereo, float, 22.05 and 44.1 kHz, a spliced clip) through the work function vs the
  upstream Python `load_audio` + native ORT. Worst window margin difference 3e-6. Any decoder
  or resampler bug would show up as a margin difference, so this covers them all.
- Harness: `jobs/local-harness.js` rebuilds the function from source with `new Function` and a
  require() that maps the published names onto local onnxruntime-web, the same trick as
  `distributed-pipelining/jobs/run-stage-local.js`.

## 2026-10-24: first real dispatch

- `node jobs/run.js --group <joinKey>:<joinSecret>`, 8 clips x 4 conditions, 2 files per slice: job
  `rG1b5Gw6OILEVYEGUs5Lvp`, worked on the first try. 4 slices, 44 windows, 260 s wall
  including deploy. Clean margins match Python to 4e-5 (CSV rounding).
- Speed: about 1.0 s per window on the Mac native worker (evaluator runs `--single-threaded`
  as the Abseil workaround), 0.57 s in Node, 0.6 s in a Chrome tab, 0.3 s native ORT.
- Noisy margins differed from the local harness run at first. Not a bug: the seed hashed the
  file **id**, which was a relative path in run.js and a bare name in the harness. Now hashes
  the file name, so results don't depend on how the job was launched.
- Results vs the team's CSV: same behaviour. Genuine clips slide toward "synthetic" as noise
  rises (all 4 flip at 0 dB, 1 at 10 dB); spoofs stay caught. 23/24 noisy predictions agree
  with the team; the one difference (genuine_2 at 10 dB) sits near the boundary.

## 2026-10-24: what the spliced clip shows

- `spliced_g_s_g.flac` = genuine_1 + synthetic_1 + genuine_1 (12 s, 9 windows at 1 s hop).
  Clean, every window stays above zero (lowest +1.13), so the file is called genuine even
  though a 2.5 s synthetic clip sits in the middle (4.74 to 7.24 s). The dip is at the windows
  that straddle the splice point (2-6 s, 3-7 s); the window that is mostly synthetic (4-8 s)
  scores about +5. So the model reacts to the join more than to the fake speech, and never
  past the boundary. At 20 dB it still stays genuine (+0.67); at 10 dB it crosses zero,
  but at 10 dB some fully genuine clips flip too, so that isn't a usable signal.
- So: AASIST with sliding windows gives a coarse timeline but no reliable splice detection.
  It was never trained on partial spoofs. PartialSpoof-style frame-level models are the right
  tool for that (see PLAN.md).

## 2026-10-24: web app

- `web/index.html`, modelled on the 3KIDNAS page: API key + compute group rows + payment offer
  (localStorage), file drop, SNR/seed/hop/files-per-slice controls, deploy, live log and
  progress, results by condition, per-file verdicts and a margin timeline per window, CSV/JSON
  download. dcp-client from the scheduler; the work function is loaded via `<script src>`.
- "Run in this browser" runs the same work function in the tab with onnxruntime-web 1.23 from
  jsDelivr and a temporary require() shim. It is how the page is tested without spending
  credits, and `tools/smoke_web.js` drives it headless (Node's WebSocket + Chrome DevTools
  protocol, no npm deps).
- Gotcha: ORT's UMD bundle declares `var ort`, a non-configurable global, so `delete window.ort`
  throws. Reset it to undefined instead.
- The web folder uses symlinks to `jobs/aasist-work.js`, `models/aasist.onnx` and
  `test-audio/`, so serving `web/` alone works (3KIDNAS lesson). Copy with `rsync -aL`.
- Not yet verified: deploying from the browser to real DCP (needs a wallet-picker click). The
  same work function and requires have run on DCP from Node.
