/* Explainer deck: TrustLayer (AASIST speech-deepfake detection) on DCP.
 * Same frame as the Legendre decks: white marble background, dark grey text,
 * narration plus a [Visual: ...] block in each slide's notes.
 *
 *   PPTX_SKILL=<pptx skill dir> NODE_PATH=<global node_modules> node deck/build_deck.js
 *
 * Charts read the real DCP run in results/dcp-samples10.jsonl.
 */
const fs = require("fs");
const path = require("path");
const pptxgen = require("pptxgenjs");
const { applyTheme } = require(process.env.PPTX_SKILL + "/scripts/apply_theme.js");

const ROOT = path.resolve(__dirname, "..");
const THEME = {
  name: "White Marble",
  headFontFace: "Cambria",
  bodyFontFace: "Calibri",
  colors: {
    dk1: "2E2E2E", lt1: "FFFFFF", dk2: "6E6E6E", lt2: "EFEEEB",
    accent1: "4F5D6B", accent2: "A4493D", accent3: "B8B2A7",
    accent4: "2E2E2E", accent5: "D9D4CC", accent6: "8C7B5E",
    hlink: "4F5D6B", folHlink: "6E6E6E",
  },
};
// genuine = slate, synthetic = brick; stone greys for structure
const INK = "2E2E2E", INK2 = "6E6E6E", STONE = "B8B2A7", STONE2 = "D9D4CC", SLATE = "4F5D6B", BRICK = "A4493D", BRONZE = "8C7B5E";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";            // 13.33 x 7.5
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "TrustLayer on DCP";
pres.author = "Distributive";
const C = pres.SchemeColor;
const MARBLE = path.join(__dirname, "marble_light.png");

pres.defineSlideMaster({
  title: "TITLE",
  background: { path: MARBLE },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.7, y: 2.1, w: 11.93, h: 1.4, fontSize: 44, bold: true, color: C.text1, align: "center", valign: "middle", margin: 0 } } },
    { placeholder: { options: { name: "body", type: "body", x: 1.5, y: 3.55, w: 10.33, h: 0.9, fontSize: 20, color: C.text2, align: "center", valign: "top", margin: 0 } } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT",
  background: { path: MARBLE },
  slideNumber: { x: 12.3, y: 7.0, w: 0.7, h: 0.3, fontSize: 10, color: C.text2, align: "right" },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.4, w: 12.1, h: 0.8, fontSize: 32, bold: true, color: C.text1, align: "left", valign: "middle", margin: 0 } } },
    { text: { text: "TrustLayer on DCP", options: { x: 0.6, y: 7.0, w: 6, h: 0.3, fontSize: 10, color: C.text2, margin: 0 } } },
  ],
});

/* ---------- drawing helpers ---------- */
function text(slide, t, o) {
  slide.addText(t, Object.assign({ isTextBox: true, margin: 0, color: C.text1, fontSize: 16, valign: "top" }, o));
}
function label(slide, t, o) { text(slide, t, Object.assign({ color: C.text2, fontSize: 12 }, o)); }
function box(slide, o) {
  slide.addShape(pres.ShapeType.rect, Object.assign({ line: { color: STONE, width: 0.75 }, fill: { color: "FFFFFF", transparency: 25 } }, o));
}
function arrow(slide, x1, y1, x2, y2, o = {}) {
  slide.addShape(pres.ShapeType.line, Object.assign({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color: INK2, width: 1.25, endArrowType: "triangle" } }, o));
}
function stat(slide, x, y, w, big, small, o = {}) {
  text(slide, big, { x, y, w, h: 0.9, fontSize: o.size ?? 40, bold: true, align: o.align ?? "left", fontFace: THEME.headFontFace, color: o.color ?? C.text1 });
  text(slide, small, { x, y: y + 0.95, w, h: o.capH ?? 0.8, fontSize: 13, color: C.text2, align: o.align ?? "left" });
}
/* waveform motif: vertical bars from an RMS envelope, centred on a baseline */
function wave(slide, x, yMid, w, hMax, env, color, o = {}) {
  const step = w / env.length, bw = step * (o.fill ?? 0.62);
  env.forEach((v, i) => {
    const h = Math.max(0.02, v * hMax);
    const c = o.colorAt ? o.colorAt(i) : color;
    slide.addShape(pres.ShapeType.rect, { x: x + i * step, y: yMid - h / 2, w: bw, h, fill: { color: c }, line: { color: c, width: 0 } });
  });
}
function bullets(slide, items, o) {
  text(slide, items.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < items.length - 1, paraSpaceAfter: 6 } })), Object.assign({ fontSize: 15 }, o));
}
function notes(slide, narration, visual) { slide.addNotes(narration.trim() + "\n\n[" + visual.trim() + "]"); }
const CHART_TEXT = { catAxisLabelColor: "6E6E6E", valAxisLabelColor: "6E6E6E", catAxisLabelFontFace: "+mn-lt", valAxisLabelFontFace: "+mn-lt",
  catAxisLabelFontSize: 12, valAxisLabelFontSize: 12, legendFontFace: "+mn-lt", legendFontSize: 12, legendColor: "6E6E6E",
  titleFontFace: "+mn-lt", titleColor: "2E2E2E", titleFontSize: 14, dataLabelFontFace: "+mn-lt", dataLabelFontSize: 11, dataLabelColor: "2E2E2E" };

/* ---------- data ---------- */
const ENV = JSON.parse(fs.readFileSync(path.join(__dirname, "envelopes.json"), "utf8"));
const RUN = fs.readFileSync(path.join(ROOT, "results/dcp-samples10.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).result);
const FILES = RUN.flatMap((r) => r.files);
const WINDOWS = RUN.reduce((a, r) => a + r.env.windows, 0);
const INFER_S = RUN.reduce((a, r) => a + r.env.inferMs, 0) / 1000;
const SEC_PER_WINDOW = INFER_S / WINDOWS;
const COND = ["clean", "20 dB", "10 dB", "0 dB"];
const condKey = (c) => (c.snr === null ? "clean" : c.snr + " dB");
const labelled = FILES.filter((f) => f.label && !/spliced|44100/.test(f.name));   // the 8 repo clips
function rate(label) {
  return COND.map((k) => {
    const xs = labelled.filter((f) => f.label === label).map((f) => f.conditions.find((c) => condKey(c) === k));
    return xs.filter((c) => c.prediction === label).length;
  });
}
const GEN_OK = rate("genuine"), SYN_OK = rate("synthetic");
const N_GEN = labelled.filter((f) => f.label === "genuine").length, N_SYN = labelled.filter((f) => f.label === "synthetic").length;
function meanMargin(label) {
  return COND.map((k) => {
    const xs = labelled.filter((f) => f.label === label).map((f) => f.conditions.find((c) => condKey(c) === k).first);
    return +(xs.reduce((a, v) => a + v, 0) / xs.length).toFixed(2);
  });
}
const SPLICED = FILES.find((f) => /spliced/.test(f.name));
const SPLICE_FROM = 4.741, SPLICE_TO = 4.741 + 2.5;   // genuine_1 (4.74 s) + synthetic_1 (2.5 s) + genuine_1
const fmt = (v) => v.toFixed(2);

/* ================= slides ================= */
pres.addSection({ title: "Opening" });
{
  const s = pres.addSlide({ masterName: "TITLE", sectionTitle: "Opening" });
  s.addText("TrustLayer on DCP", { placeholder: "title" });
  s.addText("Scoring speech deepfakes across a network of browsers and machines", { placeholder: "body" });
  wave(s, 1.2, 5.55, 5.3, 1.1, ENV.genuine, SLATE);
  wave(s, 6.83, 5.55, 5.3, 1.1, ENV.synthetic, BRICK);
  label(s, "genuine", { x: 1.2, y: 6.25, w: 5.3, h: 0.3, align: "center" });
  label(s, "synthetic", { x: 6.83, y: 6.25, w: 5.3, h: 0.3, align: "center" });
  notes(s, `
Two short recordings. One is a person reading a sentence. The other is a machine that learned to sound like that person. By ear, most of us cannot reliably tell them apart. This project takes a detector that can, a small neural network built by NAVER and tested by a student team at QMIND Camp, and turns it into a job that runs anywhere on the DCP network: in a browser tab, on a laptop, on a server. Every step, from opening the audio file to the final verdict, runs on the workers.`, `
Visual: white marble. Two waveforms drawn as vertical bars fade in under the title: the genuine one in slate on the left, the synthetic one in brick on the right. For the video, play each clip as its waveform lights up from left to right, then hold both side by side.`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Opening" });
  s.addText("Why this matters", { placeholder: "title" });
  stat(s, 0.9, 1.45, 4.3, "3 seconds", "of recorded speech was enough for Microsoft's VALL-E to imitate a new voice (2023)", { size: 40 });
  stat(s, 0.9, 3.25, 4.3, "2015", "first ASVspoof challenge. The anti-spoofing benchmark has run roughly every two years since.", { size: 40 });
  stat(s, 0.9, 5.05, 4.3, "4.04 s", "of audio is all this detector looks at for one verdict, so long recordings mean many runs", { size: 40 });
  text(s, "Cloned voices are cheap to make. Checking them has to happen wherever audio arrives, at the volume it arrives.", { x: 5.7, y: 1.6, w: 7.0, h: 1.0, fontSize: 17, bold: true });
  bullets(s, [
    "Phone fraud that imitates a family member or an executive.",
    "Newsrooms and platforms checking clips before they spread.",
    "Researchers re-scoring whole corpora every time a model, a noise condition or an attack changes.",
    "Each clip is independent of every other clip, so the work splits cleanly across machines.",
  ], { x: 5.7, y: 2.9, w: 7.0, h: 3.2 });
  notes(s, `
Voice cloning has become easy. In 2023, Microsoft's VALL-E research model imitated a new speaker from a three-second sample. Detection research has a long track record of its own: the ASVspoof challenge started in 2015 and has run roughly every two years since. But detection is also a compute problem. The detector in this project makes one decision per four seconds of audio. A one-hour recording is about nine hundred decisions, and a benchmark with tens of thousands of clips, tested under several noise conditions, is millions. Every one of those is independent, which is exactly the kind of work DCP spreads across many machines.`, `
Visual: three numbers drop in on the left: 3 seconds, 2015, 4.04 s. On the right, icons appear beside the bullets: a phone, a newspaper, a stack of audio files, and a fan of arrows splitting one job across many machines.`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Opening" });
  s.addText("Whose work this is", { placeholder: "title" });
  const cols = [
    ["The detector", "AASIST: audio anti-spoofing using integrated spectro-temporal graph attention. Jee-weon Jung and colleagues, NAVER Clova, ICASSP 2022. Pretrained weights, MIT licence."],
    ["The camp project", "TrustLayer, a QMIND Camp team: Reyan, Jinpeng, Kyle, Daniel, Shreya and Abdullah, advised by Shaina Raza. They wrapped the detector, tested it under noise and built a comparison screen."],
    ["The data", "ASVspoof 2019 logical access: bona fide speech plus clips from 2019-era text-to-speech and voice-conversion systems. Showcase samples from the Yamagishi lab at NII."],
    ["What we added", "ONNX conversion, a work function that does the whole pipeline in the DCP sandbox, a Node dispatcher, a web page that deploys the job, and the tests that tie them together."],
  ];
  cols.forEach(([h, b], i) => {
    const x = 0.6 + i * 3.08;
    box(s, { x, y: 1.55, w: 2.85, h: 3.6 });
    text(s, h, { x: x + 0.22, y: 1.75, w: 2.45, h: 0.5, fontSize: 18, bold: true, fontFace: THEME.headFontFace, color: i === 3 ? SLATE : C.text1 });
    text(s, b, { x: x + 0.22, y: 2.35, w: 2.45, h: 2.7, fontSize: 14 });
  });
  notes(s, `
Credit first. The detector is AASIST, published by Jee-weon Jung and colleagues at NAVER Clova in 2022, released with pretrained weights under the MIT licence. The project around it is TrustLayer, built at QMIND Camp by Reyan, Jinpeng, Kyle, Daniel, Shreya and Abdullah, with advice from Shaina Raza. They wrapped the model, measured how background noise changes its answers, and built a screen to compare clips. The training and test data come from the ASVspoof 2019 challenge. Our part is the last column: getting all of this to run on DCP, from the raw audio file to the verdict, and a web page anyone can use to launch it.`, `
Visual: four stone cards appear left to right. The first shows a small graph-network icon, the second the camp team's names, the third a waveform with a "2019" tag, the fourth the DCP logo. The fourth card's heading is in slate to mark it as ours.`);
}

pres.addSection({ title: "The detector" });
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "The detector" });
  s.addText("How AASIST tells real speech from synthetic", { placeholder: "title" });
  const steps = [
    ["4.04 s of audio", "64,600 samples at 16 kHz"],
    ["Sinc filter bank", "70 fixed band-pass filters"],
    ["Residual encoder", "6 convolution blocks"],
    ["Two graphs", "one over frequency, one over time"],
    ["Graph attention", "joins the two, in two branches"],
    ["Two scores", "synthetic, genuine"],
  ];
  const w = 1.78, gap = 0.27, y = 1.75;
  steps.forEach(([h, b], i) => {
    const x = 0.6 + i * (w + gap);
    box(s, { x, y, w, h: 1.45, fill: { color: i === 5 ? "F2EEEA" : "FFFFFF", transparency: 20 } });
    text(s, h, { x: x + 0.12, y: y + 0.15, w: w - 0.24, h: 0.55, fontSize: 15, bold: true, align: "center" });
    label(s, b, { x: x + 0.12, y: y + 0.75, w: w - 0.24, h: 0.6, align: "center", fontSize: 12 });
    if (i < steps.length - 1) arrow(s, x + w + 0.03, y + 0.72, x + w + gap - 0.03, y + 0.72);
  });
  wave(s, 0.6, 4.45, 3.9, 0.9, ENV.genuine.slice(0, 60), SLATE);
  text(s, "margin = genuine score − synthetic score", { x: 5.0, y: 3.85, w: 7.7, h: 0.5, fontSize: 20, bold: true, fontFace: THEME.headFontFace });
  bullets(s, [
    "Above zero, the model calls the clip genuine; below zero, synthetic. The size is confidence of a sort, not a probability.",
    "About 300,000 weights, 1.3 MB. Small enough to send with every job.",
    "Trained on ASVspoof 2019 only, so it knows 2019-era synthesis, not today's voice-cloning services.",
  ], { x: 5.0, y: 4.5, w: 7.7, h: 2.2 });
  notes(s, `
AASIST listens to exactly four point oh four seconds of audio at a time. A bank of seventy fixed band-pass filters splits the sound into frequency bands, a stack of six convolution blocks turns that into a compact picture, and then the clever part: two small graphs, one whose nodes are frequency bands and one whose nodes are moments in time, are joined by graph attention so the model can relate "this band" to "that moment". Out come two scores. We report the margin, genuine minus synthetic: above zero means genuine. The whole model is about three hundred thousand weights, one point three megabytes, which matters later because it is small enough to send with every job. Its main limit is its training data: it learned from 2019 systems.`, `
Visual: the six boxes build left to right with arrows; a short waveform slides into the first box, turns into seventy coloured stripes in the second, a small grid in the third, two node-and-edge graphs in the fourth that knit together in the fifth, and two bars in the last, one taller than the other. Then the margin formula types itself out.`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "The detector" });
  s.addText("The camp question: does background noise fool it", { placeholder: "title" });
  s.addChart(pres.ChartType.line, [
    { name: "genuine clips", labels: COND, values: meanMargin("genuine") },
    { name: "synthetic clips", labels: COND, values: meanMargin("synthetic") },
  ], Object.assign({
    x: 0.6, y: 1.45, w: 7.4, h: 5.1, chartColors: [SLATE, BRICK], lineSize: 3, lineDataSymbol: "circle", lineDataSymbolSize: 9,
    showTitle: true, title: "Average margin, 4 genuine and 4 synthetic clips (DCP run)",
    showLegend: true, legendPos: "b", valAxisTitle: "margin", showValAxisTitle: true, valAxisTitleColor: "6E6E6E", valAxisTitleFontFace: "+mn-lt",
    valGridLine: { color: "D9D4CC", size: 0.5 }, catGridLine: { style: "none" },
  }, CHART_TEXT));
  text(s, "The team's experiment", { x: 8.5, y: 1.6, w: 4.2, h: 0.45, fontSize: 18, bold: true, fontFace: THEME.headFontFace });
  bullets(s, [
    "8 showcase clips, 4 genuine and 4 synthetic.",
    "Each clean and with white noise at 20, 10 and 0 dB signal-to-noise.",
    "Noise drags genuine speech down toward the boundary. At 0 dB, every genuine clip is called synthetic.",
    "Synthetic clips stay synthetic: the detector fails in one direction, false alarms.",
  ], { x: 8.5, y: 2.2, w: 4.2, h: 4.0 });
  notes(s, `
The camp team asked a practical question: what happens to the detector when the recording is noisy, as real phone calls and street recordings are. They took eight clips, added white noise at three levels, and watched the margin. Our DCP run reproduces their picture. Genuine speech starts far above zero and slides down as the noise grows; at zero decibels, noise as loud as the voice, every genuine clip is called synthetic. Synthetic clips stay synthetic throughout. So the failure is one-sided: noise produces false alarms, not missed fakes. That is a useful thing to know before trusting a verdict on a noisy call.`, `
Visual: the chart draws itself from left to right. The slate genuine line falls steeply toward zero and below; the brick synthetic line stays low. A soft hiss sound effect rises as the line moves right. Then the four bullets appear.`);
}

pres.addSection({ title: "What we built" });
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "What we built" });
  s.addText("One model file any worker can run", { placeholder: "title" });
  stat(s, 0.9, 1.5, 3.6, "1.63 MB", "ONNX model, exported from the 1.28 MB PyTorch weights. About 2.2 MB as base64 inside a job.", { size: 44 });
  stat(s, 4.85, 1.5, 3.6, "3 × 10⁻⁶", "largest difference from PyTorch, over 32 test windows (8 clips × 4 noise levels)", { size: 44 });
  stat(s, 8.8, 1.5, 3.9, "0", "verdicts changed by the conversion, with optimisation on or off, one clip at a time or 32 at once", { size: 44 });
  box(s, { x: 0.9, y: 3.9, w: 11.8, h: 2.6 });
  text(s, "What made it convert cleanly", { x: 1.15, y: 4.1, w: 11.3, h: 0.45, fontSize: 18, bold: true, fontFace: THEME.headFontFace });
  bullets(s, [
    "The sinc filter bank is fixed, not learned, so it becomes one constant convolution.",
    "The graph pooling keeps a fixed number of nodes because the input length is fixed, so the only dynamic dimension is the batch.",
    "All 34 operation types in the graph (convolution, attention, TopK, scatter) are supported by ONNX Runtime's WebAssembly backend, which every DCP worker can run.",
  ], { x: 1.15, y: 4.65, w: 11.3, h: 1.8 });
  notes(s, `
The first step was to turn the PyTorch model into ONNX, a portable model format that ONNX Runtime can execute in a browser through WebAssembly. The file is one point six megabytes. We checked it against the original on thirty-two inputs, the eight clips under four noise levels: the largest difference in any score was three millionths, and not one verdict changed. It converted on the first try, because the model's front end is a fixed filter bank and its graph sizes are fixed by the input length. Every operation it uses is supported by the WebAssembly runtime, which means any DCP worker, browser or native, can run it.`, `
Visual: a PyTorch logo morphs into an ONNX file icon; the three numbers count up. Below, the three reasons appear one by one with small icons: a filter shape, a fixed-size grid, and a checklist with 34 ticks.`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "What we built" });
  s.addText("The client packs the files; the workers do the rest", { placeholder: "title" });
  box(s, { x: 0.6, y: 1.6, w: 3.3, h: 4.6, fill: { color: "FFFFFF", transparency: 10 } });
  text(s, "Your machine", { x: 0.85, y: 1.8, w: 2.8, h: 0.45, fontSize: 18, bold: true, fontFace: THEME.headFontFace });
  bullets(s, ["Reads each audio file as it is: WAV or FLAC, any rate.", "Encodes it as text (base64).", "Groups a few files per slice.", "That's all. Milliseconds per file."], { x: 0.85, y: 2.4, w: 2.85, h: 3.6, fontSize: 14 });
  arrow(s, 4.0, 3.9, 4.75, 3.9, { line: { color: INK2, width: 2, endArrowType: "triangle" } });
  label(s, "DCP", { x: 4.0, y: 3.5, w: 0.75, h: 0.3, align: "center" });
  const steps = [
    ["Decode", "WAV (PCM or float) and FLAC, written in plain JavaScript"],
    ["Mix and resample", "to mono at 16 kHz, the same filter as scipy's resample_poly"],
    ["Window", "4.04 s windows, sliding every second across long clips"],
    ["Add noise", "white noise at each chosen SNR, seeded so any worker gives the same result"],
    ["Run the model", "batches of windows through ONNX Runtime (WebAssembly)"],
    ["Report", "a margin per window, and a verdict per file"],
  ];
  box(s, { x: 4.85, y: 1.6, w: 7.85, h: 4.6, fill: { color: "F2EEEA", transparency: 20 } });
  text(s, "Each DCP worker", { x: 5.1, y: 1.8, w: 7.4, h: 0.45, fontSize: 18, bold: true, fontFace: THEME.headFontFace, color: SLATE });
  steps.forEach(([h, b], i) => {
    const y = 2.4 + i * 0.6;
    s.addShape(pres.ShapeType.ellipse, { x: 5.1, y: y + 0.04, w: 0.36, h: 0.36, fill: { color: SLATE }, line: { color: SLATE, width: 0 } });
    text(s, String(i + 1), { x: 5.1, y: y + 0.04, w: 0.36, h: 0.36, fontSize: 12, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    text(s, [{ text: h + "  ", options: { bold: true } }, { text: b, options: { color: INK2 } }], { x: 5.65, y, w: 6.9, h: 0.45, fontSize: 14, valign: "middle" });
  });
  label(s, "Doing this on the client would make one machine the bottleneck for the whole corpus. Here it scales with the number of workers.", { x: 0.6, y: 6.4, w: 12.1, h: 0.4, fontSize: 13 });
  notes(s, `
The key design choice: the computer that launches the job does almost nothing. It reads each audio file exactly as it is on disk, turns it into text so it can travel inside the job, and groups a few files into each slice. Everything else happens on the workers. Each worker decodes the file, with WAV and FLAC decoders written in plain JavaScript; mixes it to mono and resamples it to sixteen kilohertz with the same filter scipy uses; cuts it into four-second windows, sliding a second at a time across long recordings; adds the requested noise, seeded so the answer doesn't depend on which worker ran it; runs the model on batches of windows; and reports a margin for every window and a verdict for every file. If the launching machine did the decoding, it would become the bottleneck for a big corpus. This way the work grows with the number of workers.`, `
Visual: on the left, a laptop packs audio files into envelopes. The envelopes travel along the arrow into the large right-hand panel, where each numbered step lights up in turn: a file opens, two channels merge into one, a ruler slices the waveform into overlapping windows, static sprinkles over one copy, the windows pass through a small network, and a row of scores comes out.`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "What we built" });
  s.addText("How the job is laid out", { placeholder: "title" });
  const cards = [
    ["Input set", "changes every slice", ["A few raw audio files per slice, as base64.", "Each with a name and, if known, a label.", "Files per slice chosen so a slice runs 10 to 30 seconds."]],
    ["Static arguments", "shared by every slice", ["The model itself, 2.2 MB as base64. Swap in another checkpoint without changing code.", "The plan: noise levels, seeds, window hop.", "Options: WebAssembly or WebGPU, batch size, how to combine windows."]],
    ["Work function", "the pipeline", ["One self-contained function, so a browser page can deploy it.", "Its only dependency is DCP's published ONNX Runtime package.", "Keeps the loaded model between slices on the same worker."]],
  ];
  cards.forEach(([h, sub, items], i) => {
    const x = 0.6 + i * 4.1;
    box(s, { x, y: 1.55, w: 3.85, h: 3.9 });
    text(s, h, { x: x + 0.25, y: 1.75, w: 3.35, h: 0.5, fontSize: 22, bold: true, fontFace: THEME.headFontFace });
    label(s, sub, { x: x + 0.25, y: 2.3, w: 3.35, h: 0.35, fontSize: 13 });
    bullets(s, items, { x: x + 0.25, y: 2.8, w: 3.35, h: 2.5, fontSize: 14 });
  });
  notes(s, `
DCP jobs have three parts, and the rule for splitting this one is simple. What changes from slice to slice goes in the input set: a handful of raw audio files, with names and labels. What every slice shares goes in the static arguments, which a worker fetches once: the model file itself, the plan of noise levels and seeds, and a few options. Putting the model there means a stronger checkpoint can be dropped in without touching any code. And the work function holds the pipeline. It is a single self-contained function on purpose: a web page cannot bundle local code modules the way Node can, so the only thing it pulls in is DCP's published ONNX Runtime package. The worker keeps the model loaded between slices, so the startup cost is paid once.`, `
Visual: three cards rise in turn. On the first, small file icons stack into a slice; on the second, a model icon, a dial for noise and a seed icon sit side by side with a "fetched once" stamp; on the third, a single function block with one cable plugging into an "ONNX Runtime" package.`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "What we built" });
  s.addText("Same numbers on every runtime", { placeholder: "title" });
  const hdr = { bold: true, color: "6E6E6E", fontSize: 13 };
  const rows = [
    [{ text: "Runtime", options: hdr }, { text: "Largest margin difference", options: hdr }, { text: "Time per 4 s window", options: hdr }],
    ["Python + native ONNX Runtime (reference)", "0", "0.3 s"],
    ["Node + ONNX Runtime WebAssembly (local harness)", "3 × 10⁻⁶", "0.57 s"],
    ["Chrome tab (same function, tested in the page)", "same function, same results", "0.6 s"],
    ["DCP worker (native Mac worker, WebAssembly)", "4 × 10⁻⁵ (CSV rounding)", `${SEC_PER_WINDOW.toFixed(1)} s`],
  ];
  s.addTable(rows, { x: 0.6, y: 1.55, w: 7.6, colW: [3.6, 2.4, 1.6], fontSize: 14, fontFace: THEME.bodyFontFace, color: INK, border: { type: "solid", color: STONE2, pt: 0.75 }, fill: { color: "FFFFFF", transparency: 20 }, rowH: 0.62, valign: "middle" });
  text(s, "23 test files", { x: 8.7, y: 1.55, w: 4.0, h: 0.6, fontSize: 30, bold: true, fontFace: THEME.headFontFace });
  label(s, "run through the work function and through the original Python loader, compared window by window", { x: 8.7, y: 2.2, w: 4.0, h: 0.7, fontSize: 13 });
  bullets(s, ["WAV: 16-bit, 32-bit float", "FLAC: 16-bit mono, 24-bit stereo", "44.1 kHz and 22.05 kHz sources", "a 12-second clip with 9 windows"], { x: 8.7, y: 3.1, w: 4.0, h: 2.2, fontSize: 14 });
  label(s, "A bug in the decoder or the resampler would show up as a score difference, so one end-to-end check covers all of them.", { x: 0.6, y: 5.0, w: 7.6, h: 0.8, fontSize: 13 });
  notes(s, `
We wrote our own audio decoders and resampler, so we had to prove they agree with the original. Rather than test each piece separately, we ran twenty-three test files, covering both formats, several bit depths, stereo, and two other sample rates, through the whole work function and through the camp team's Python loader, and compared the model's scores window by window. The largest difference was three millionths. Any mistake in decoding or resampling would have shown up right there. The same function gives the same numbers in Node, in a Chrome tab, and on a real DCP worker. Speed is about half a second to one second per four-second window on a single CPU thread.`, `
Visual: the table fills row by row, each row getting a green tick as it appears. On the right, small format badges (WAV, FLAC, 24-bit, stereo, 44.1k, 22k) drop into a funnel that leads to a single "matches" stamp.`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "What we built" });
  s.addText("A web page that launches the job", { placeholder: "title" });
  const shot = path.join(__dirname, "web-results.png");
  s.addImage({ path: shot, x: 0.6, y: 1.4, w: 5.35 * 940 / 1155, h: 5.35, altText: "Results section of the TrustLayer web page" });
  bullets(s, [
    "Open dcp.dev/projects/trustlayer. Nothing to install.",
    "Paste an API key, pick compute groups and a payment offer.",
    "Drop WAV or FLAC files, or load the sample clips.",
    "Choose noise levels, seeds and how far windows slide.",
    "Deploy: slices stream back with a live log and progress bar.",
    "Results by condition, a verdict per file, and a timeline of every window. Download as CSV or JSON.",
    "A QR code beside the log opens a browser worker in the same compute group, so anyone in the room can help run the job.",
  ], { x: 5.6, y: 1.55, w: 7.1, h: 5.2, fontSize: 15 });
  notes(s, `
To make this usable without a terminal, we built a web page, hosted at dcp dot dev slash projects slash trustlayer, in the same style as our 3KIDNAS galaxy-fitting page. You paste your DCP API key, choose which compute groups may run the job, drop in your audio files and pick the noise conditions. Deploy sends the job; slices come back one by one with a live log. The results show how many genuine clips stayed genuine and how many fakes were caught under each condition, a verdict per file, and a small timeline per file showing the score of every window. Beside the log there is a QR code: scan it with a phone or open it on a laptop and that device becomes a DCP worker in the same compute group, so anyone in the room can help run the job.`, `
Visual: screen recording of the page. Files are dragged onto the drop zone, the noise checkboxes ticked, Deploy pressed; the progress bar fills as slices return and the results table populates. Zoom in on one timeline.`);
}

pres.addSection({ title: "What it found" });
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "What it found" });
  s.addText("Noise turns real voices \"synthetic\"", { placeholder: "title" });
  s.addChart(pres.ChartType.bar, [
    { name: `genuine kept genuine (of ${N_GEN})`, labels: COND, values: GEN_OK },
    { name: `synthetic caught (of ${N_SYN})`, labels: COND, values: SYN_OK },
  ], Object.assign({
    x: 0.6, y: 1.45, w: 7.6, h: 5.1, barDir: "col", barGapWidthPct: 60, chartColors: [SLATE, BRICK],
    showValue: true, dataLabelPosition: "outEnd", valAxisMaxVal: 4, valAxisMinVal: 0, valAxisMajorUnit: 1,
    showTitle: true, title: "Correct verdicts by noise level (DCP run)", showLegend: true, legendPos: "b",
    valGridLine: { color: "D9D4CC", size: 0.5 }, catGridLine: { style: "none" },
  }, CHART_TEXT));
  stat(s, 8.7, 1.6, 4.0, `${GEN_OK[3]} of ${N_GEN}`, "genuine clips still called genuine at 0 dB, noise as loud as the voice", { size: 44 });
  stat(s, 8.7, 3.4, 4.0, `${SYN_OK[3]} of ${N_SYN}`, "synthetic clips still caught at 0 dB", { size: 44 });
  label(s, "Eight hand-picked clips show the direction of the effect, not the detector's accuracy in the wild.", { x: 8.7, y: 5.3, w: 4.0, h: 0.9, fontSize: 13 });
  notes(s, `
Here is the camp experiment, run on DCP. With clean audio and at twenty decibels, every verdict is right. At ten decibels, one genuine clip starts to be called synthetic. At zero decibels, none of the genuine clips survive, while every synthetic clip is still caught. In other words, this detector treats noise as a sign of synthesis. A caution: these are eight hand-picked showcase clips, so they show the direction of the effect, not a measured accuracy. Measuring it properly means running thousands of clips under many conditions, which is exactly what this job is built for.`, `
Visual: paired columns grow from left to right, one pair per noise level; the slate genuine column shrinks to nothing at 0 dB while the brick column stays full. The two big numbers on the right count in.`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "What it found" });
  s.addText("A fake spliced into real speech slips through", { placeholder: "title" });
  const starts = SPLICED.windowStarts;
  const cl = SPLICED.conditions.find((c) => c.snr === null), c20 = SPLICED.conditions.find((c) => c.snr === 20);
  wave(s, 0.6, 2.05, 7.6, 0.75, ENV.spliced, SLATE, { colorAt: (i) => { const t = (i + 0.5) / ENV.spliced.length * SPLICED.seconds; return t >= SPLICE_FROM && t < SPLICE_TO ? BRICK : SLATE; } });
  label(s, "genuine", { x: 0.6, y: 2.5, w: 2.9, h: 0.3, align: "center" });
  label(s, "synthetic", { x: 0.6 + 7.6 * SPLICE_FROM / SPLICED.seconds, y: 2.5, w: 7.6 * 2.5 / SPLICED.seconds, h: 0.3, align: "center", color: BRICK });
  label(s, "genuine", { x: 0.6 + 7.6 * SPLICE_TO / SPLICED.seconds, y: 2.5, w: 7.6 * (SPLICED.seconds - SPLICE_TO) / SPLICED.seconds, h: 0.3, align: "center" });
  s.addChart(pres.ChartType.line, [
    { name: "clean", labels: starts.map((t) => `${t.toFixed(0)}–${(t + 4.04).toFixed(0)} s`), values: cl.margins.map((v) => +v.toFixed(2)) },
    { name: "20 dB noise", labels: starts.map((t) => `${t.toFixed(0)}–${(t + 4.04).toFixed(0)} s`), values: c20.margins.map((v) => +v.toFixed(2)) },
  ], Object.assign({
    x: 0.6, y: 2.85, w: 7.6, h: 3.9, chartColors: [SLATE, BRONZE], lineSize: 3, lineDataSymbol: "circle", lineDataSymbolSize: 7,
    showTitle: true, title: "Margin of each 4-second window", showLegend: true, legendPos: "b", valAxisMinVal: -2, valAxisMaxVal: 10, valAxisMajorUnit: 2,
    valGridLine: { color: "D9D4CC", size: 0.5 }, catGridLine: { style: "none" }, catAxisLabelFontSize: 10,
  }, CHART_TEXT));
  stat(s, 8.7, 1.6, 4.0, `+${fmt(cl.min)}`, "lowest window margin, clean: still above zero, so the whole file is called genuine", { size: 44 });
  bullets(s, [
    "The lowest windows (2–6 s, 3–7 s) straddle the splice point at 4.7 s. The window that is mostly synthetic (4–8 s) still scores about +5.",
    "AASIST was trained on whole clips, each entirely real or entirely fake. It was never taught to find a fake inside a real one.",
    "Models trained on partly faked audio (the PartialSpoof data) score every 20 ms and mark the edits.",
  ], { x: 8.7, y: 3.5, w: 4.0, h: 3.2, fontSize: 14 });
  notes(s, `
We built one test the camp project didn't have: a real recording with a synthetic sentence spliced into the middle. Sliding the detector across it one second at a time, the score drops for the windows that straddle the point where real speech turns into the fake, then recovers. The window that is mostly synthetic still scores well above zero. Nothing drops below zero, so the file as a whole is called genuine. That is not a bug in the pipeline; it is what this model was trained for. It learned from clips that were entirely real or entirely fake, and never saw one hidden inside the other. Finding edits like this needs a different kind of model, trained on partly faked audio, that scores every twenty milliseconds and marks where the edits are.`, `
Visual: the waveform at the top plays left to right; the middle section is brick-coloured, the synthetic part. A four-second window frame slides along it, and as it moves, the matching point is added to the chart below. The line sags as the window frame crosses the left edge of the brick section and comes back up while the frame is still mostly over it, staying above the zero gridline. A red marker shows how far it would need to fall.`);
}

pres.addSection({ title: "Next" });
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Next" });
  s.addText("Stronger detectors fit the same job", { placeholder: "title" });
  const cols = [
    ["AASIST (today)", SLATE, ["300 thousand weights, 1.6 MB", "Learned from 2019-era speech synthesis", "One verdict per 4-second window", "About 1 s per window on a CPU worker"]],
    ["Speech encoder + AASIST", BRONZE, ["A large pretrained speech model (wav2vec 2.0 / XLS-R) feeding a small AASIST-style classifier", "About 300 million weights: 1.2 GB, or about 300 MB at 8-bit", "Clearly better on real-world recordings in published results", "Much more compute per clip, which is where DCP pays off"]],
    ["Partial-fake localisation", BRICK, ["Same kind of speech encoder, trained on partly faked audio", "Scores every 20 ms and marks real-to-fake boundaries", "Answers both \"is it fake?\" and \"where was it edited?\"", "Same windowed job, finer output"]],
  ];
  cols.forEach(([h, col, items], i) => {
    const x = 0.6 + i * 4.1;
    box(s, { x, y: 1.55, w: 3.85, h: 3.9 });
    s.addShape(pres.ShapeType.ellipse, { x: x + 0.25, y: 1.82, w: 0.3, h: 0.3, fill: { color: col }, line: { color: col, width: 0 } });
    text(s, h, { x: x + 0.7, y: 1.75, w: 3.0, h: 0.5, fontSize: 18, bold: true, fontFace: THEME.headFontFace });
    bullets(s, items, { x: x + 0.25, y: 2.5, w: 3.35, h: 2.85, fontSize: 14 });
  });
  label(s, "The job layout doesn't change: swap the model in the static arguments, keep the decoding, windowing and noise.", { x: 0.6, y: 5.65, w: 12.1, h: 0.4, fontSize: 13 });
  notes(s, `
AASIST is a good starting point because it is small, but it is not the strongest detector available. Most of the best recent systems put a large pretrained speech model, such as wav2vec 2.0 or XLS-R, in front of a small classifier, often AASIST itself. They do noticeably better on real-world recordings, at about a thousand times the size: around three hundred million weights, three hundred megabytes when quantised. We have already run a model of that size on DCP. The third column is the answer to the spliced clip: models trained on partly faked audio that score every twenty milliseconds and mark where the edits are. None of this changes the job: the model travels in the static arguments, and the decoding, windowing and noise stay exactly as they are.`, `
Visual: three cards; under each heading, a model icon scaled to its size, tiny for AASIST and large for the other two. On the third card, a waveform with two small boundary markers around an edited section.`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Next" });
  s.addText("What a full benchmark run looks like", { placeholder: "title" });
  const hours = 71237 * SEC_PER_WINDOW / 3600;
  stat(s, 0.9, 1.5, 3.7, "71,237", "clips in the ASVspoof 2019 logical-access evaluation set", { size: 44 });
  stat(s, 4.85, 1.5, 3.7, `≈ ${Math.round(hours)} h`, `of one worker's time for a single clean pass, at ${SEC_PER_WINDOW.toFixed(1)} s per window and about one window per clip`, { size: 44 });
  stat(s, 8.8, 1.5, 3.9, `≈ ${Math.round(hours * 60 / 100)} min`, "on 100 workers, and every extra noise level or seed multiplies the work, not the wait", { size: 44 });
  box(s, { x: 0.9, y: 3.9, w: 11.8, h: 2.55 });
  text(s, "Next steps", { x: 1.15, y: 4.1, w: 11.3, h: 0.45, fontSize: 18, bold: true, fontFace: THEME.headFontFace });
  bullets(s, [
    "Run jobs from dcp.dev/projects/trustlayer on the Queen's compute group and the public network.",
    "Run the full ASVspoof 2019 evaluation set: clean, then a noise sweep with several seeds.",
    "Add an MP3 decoder for recordings as they usually arrive, and time WebGPU against WebAssembly.",
    "Convert a speech-encoder detector and a partial-fake localiser, and run them through the same job.",
  ], { x: 1.15, y: 4.65, w: 11.3, h: 1.75 });
  notes(s, `
To put numbers on scale: the standard ASVspoof 2019 evaluation set has seventy-one thousand two hundred and thirty-seven clips. Most are shorter than four seconds, so about one window each. At the speed we measured on a worker, a single clean pass is roughly ${Math.round(hours)} hours of one machine's time. Spread over a hundred workers, it's about ${Math.round(hours * 60 / 100)} minutes, and running more noise levels or more seeds adds work but not waiting time, because each new condition is just more slices. The next steps: deploy the page publicly, run the full evaluation set with a noise sweep, add MP3 support, measure WebGPU, and bring in the stronger models.`, `
Visual: a tall stack of 71,237 tiny audio-file icons. A single worker icon starts working through it and a clock spins for "${Math.round(hours)} hours". Then the stack fans out across a grid of 100 worker icons and the clock snaps to "${Math.round(hours * 60 / 100)} minutes".`);
}
{
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Next" });
  s.addText("Architecture", { placeholder: "title" });
  const node = (x, y, w, h, title, body, fill) => {
    box(s, { x, y, w, h, fill: { color: fill || "FFFFFF", transparency: 15 } });
    text(s, title, { x: x + 0.18, y: y + 0.14, w: w - 0.36, h: 0.4, fontSize: 16, bold: true, fontFace: THEME.headFontFace });
    label(s, body, { x: x + 0.18, y: y + 0.6, w: w - 0.36, h: h - 0.7, fontSize: 12.5 });
  };
  node(0.6, 1.6, 3.2, 1.9, "Web page or Node CLI", "Reads files, packs slices, sends the model and plan. Collects results into a table, CSV and JSON.");
  node(5.05, 1.6, 3.2, 1.9, "DCP scheduler", "Holds the job and hands slices to workers in the chosen compute groups. Payment from the user's wallet.");
  node(9.5, 1.6, 3.2, 1.9, "Package server", "Serves DCP's published ONNX Runtime build (onnxruntime-dcp) to every worker.");
  node(5.05, 4.35, 7.65, 2.1, "Workers", "Browser tabs, native workers (Mac, Linux, Windows) and Docker workers. Each runs the work function in its sandbox: decode, resample, window, add noise, run the model, return margins. The model stays loaded between slices.", "F2EEEA");
  arrow(s, 3.85, 2.3, 5.0, 2.3);
  label(s, "job", { x: 3.85, y: 1.95, w: 1.15, h: 0.3, align: "center" });
  arrow(s, 6.65, 3.55, 6.65, 4.3);
  label(s, "slices", { x: 6.75, y: 3.75, w: 1.2, h: 0.3 });
  arrow(s, 11.1, 3.55, 11.1, 4.3);
  label(s, "ONNX Runtime", { x: 9.6, y: 3.75, w: 1.45, h: 0.3, align: "right" });
  arrow(s, 5.0, 5.4, 2.2, 3.55);
  label(s, "results, per slice", { x: 1.4, y: 4.6, w: 2.4, h: 0.3 });
  notes(s, `
Here is the whole system. The web page, or the command-line tool, reads the audio files and packs them into slices, along with the model and the plan. It hands the job to the DCP scheduler, paid from the user's wallet. The scheduler gives slices to workers in the compute groups the user chose: browser tabs, native workers on Mac, Linux or Windows, and Docker workers. Each worker fetches ONNX Runtime from DCP's package server once, runs the work function on its slices, and sends the results back, slice by slice, to the page that launched the job. Nothing else is needed: no server of our own, no storage, no GPU.`, `
Visual: build the diagram in order. The page box sends a job card to the scheduler; slice cards fall to the workers panel, where browser, laptop and server icons light up; a package icon drops from the package server into each worker; then result cards fly back along the long arrow to the page, filling its table.`);
}
{
  const s = pres.addSlide({ masterName: "TITLE", sectionTitle: "Next" });
  s.addText("Try it", { placeholder: "title" });
  s.addText("Open dcp.dev/projects/trustlayer, drop in some audio, choose your noise levels, deploy.", { placeholder: "body" });
  wave(s, 1.2, 5.55, 5.3, 1.1, ENV.genuine, SLATE);
  wave(s, 6.83, 5.55, 5.3, 1.1, ENV.synthetic, BRICK);
  notes(s, `
TrustLayer started as a weekend camp project with a sharp question: can this detector be trusted on noisy audio? Running it on DCP turns that question into something you can ask at any scale, with any noise, and soon with stronger models. The page is live at dcp.dev/projects/trustlayer: open it, drop in your audio, pick the conditions, and deploy.`, `
Visual: return to the opening marble surface and the two waveforms. Both play once; the genuine one gets a slate tick, the synthetic one a brick cross. Fade to the title. End card.`);
}

(async () => {
  const out = path.join(__dirname, "trustlayer-explainer.pptx");
  await pres.writeFile({ fileName: out });
  await applyTheme(out, THEME);
  console.log("wrote", out, `(windows ${WINDOWS}, ${SEC_PER_WINDOW.toFixed(2)} s/window, genuine ok ${GEN_OK}, synthetic ok ${SYN_OK})`);
})();
