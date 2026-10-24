#!/usr/bin/env node
/*
 * Dispatch AASIST scoring to DCP. The client only reads files and base64s
 * them; decoding, resampling, windowing, noise and inference run on workers.
 *
 *   node jobs/run.js [options] <files or directories...>
 *
 *   --group key:secret    compute group (default: public)
 *   --per-slice K         files per slice (default 4)
 *   --snrs null,20,10,0   conditions; null = clean (default)
 *   --seeds 42,43         noise seeds per SNR (default 42)
 *   --hop 16000           sliding-window hop in samples (default 16000 = 1 s)
 *   --max-windows N       cap windows per file (0 = whole file)
 *   --protocol FILE       ASVspoof protocol file for labels (else from filename)
 *   --out results/NAME    output prefix (writes .jsonl, .csv)
 *   --webgpu              ask for the WebGPU EP where a worker has it
 *   --offer N             slice payment offer (default market)
 *   --limit N             only the first N files
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ORT_PACKAGES = ['onnxruntime-dcp/dcp-wasm.js', 'onnxruntime-dcp/dcp-ort.js'];

function parseArgs(argv) {
  const o = { group: null, perSlice: 4, snrs: [null], seeds: [42], hop: 16000, maxWindows: 0, protocol: null, out: null, webgpu: false, offer: null, limit: 0, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--group') o.group = v();
    else if (a === '--per-slice') o.perSlice = +v();
    else if (a === '--snrs') o.snrs = v().split(',').map((s) => (s === 'null' ? null : +s));
    else if (a === '--seeds') o.seeds = v().split(',').map(Number);
    else if (a === '--hop') o.hop = +v();
    else if (a === '--max-windows') o.maxWindows = +v();
    else if (a === '--protocol') o.protocol = v();
    else if (a === '--out') o.out = v();
    else if (a === '--webgpu') o.webgpu = true;
    else if (a === '--offer') o.offer = +v();
    else if (a === '--limit') o.limit = +v();
    else o.inputs.push(a);
  }
  return o;
}

function listAudio(inputs) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f));
    else if (/\.(wav|flac)$/i.test(p)) out.push(p);
  };
  inputs.forEach(walk);
  return out;
}

// ASVspoof protocol lines: "SPEAKER FILE_ID - ATTACK KEY" (KEY = bonafide | spoof)
function labelFor(file, protocol) {
  const stem = path.basename(file).replace(/\.(wav|flac)$/i, '');
  if (protocol && protocol.has(stem)) return protocol.get(stem) === 'bonafide' ? 'genuine' : 'synthetic';
  if (/^(genuine|bonafide)/i.test(stem)) return 'genuine';
  if (/^(synthetic|spoof)/i.test(stem)) return 'synthetic';
  return null;
}

function toCsv(rows) {
  const cols = ['id', 'label', 'snr', 'seed', 'windows', 'first', 'min', 'mean', 'prediction', 'correct', 'error'];
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n') + '\n';
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let files = listAudio(o.inputs);
  if (o.limit) files = files.slice(0, o.limit);
  if (!files.length) throw new Error('no .wav or .flac inputs');
  let protocol = null;
  if (o.protocol) {
    protocol = new Map();
    for (const line of fs.readFileSync(o.protocol, 'utf8').split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length >= 5) protocol.set(f[1], f[4]);
    }
  }

  const items = files.map((f) => ({ id: path.relative(process.cwd(), f), name: path.basename(f), label: labelFor(f, protocol), path: f }));
  const inputSet = [];
  for (let i = 0; i < items.length; i += o.perSlice) inputSet.push(items.slice(i, i + o.perSlice));

  const compute = require('dcp/compute');
  if (process.env.DCP_IDENTITY_KEY) await require('dcp/identity').set(process.env.DCP_IDENTITY_KEY);
  const { aasistWork } = require('./aasist-work');
  const modelB64 = fs.readFileSync(path.join(ROOT, 'models/aasist.onnx')).toString('base64');
  const plan = { hop: o.hop, maxWindows: o.maxWindows, snrs: o.snrs, seeds: o.seeds };
  const options = { ep: o.webgpu ? 'webgpu' : 'wasm', batch: 8, aggregate: 'min' };

  const slices = inputSet.map((group) => ({ items: group.map(({ path: p, ...rest }) => ({ ...rest, b64: fs.readFileSync(p).toString('base64') })) }));

  const job = compute.for(slices, aasistWork, [modelB64, plan, options]);
  job.requires(ORT_PACKAGES);
  job.public = { name: `TrustLayer AASIST: ${files.length} clips`, description: 'Speech deepfake scoring (AASIST, ONNX)' };
  if (o.group) {
    const [joinKey, joinSecret] = o.group.split(':');
    job.computeGroups = [joinSecret ? { joinKey, joinSecret } : { joinKey }];
  }
  if (o.webgpu) job.requirements = { environment: { webgpu: true } };

  const prefix = o.out || path.join(ROOT, 'results', `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const jsonl = fs.createWriteStream(prefix + '.jsonl');
  const t0 = Date.now();
  let got = 0;
  job.on('accepted', () => console.log(`job ${job.id} accepted: ${files.length} files in ${slices.length} slices`));
  job.on('readystatechange', (s) => console.log('state:', s));
  job.on('result', (ev) => {
    got++;
    jsonl.write(JSON.stringify({ slice: ev.sliceNumber, result: ev.result }) + '\n');
    const env = ev.result && ev.result.env;
    console.log(`slice ${ev.sliceNumber} done (${got}/${slices.length})` + (env ? `: ${env.windows} windows in ${(env.inferMs / 1000).toFixed(1)} s on ${env.ep}` : ''));
  });
  job.on('console', (c) => console.log('worker console:', c.message ?? c));
  job.on('error', (e) => console.error('slice error:', e.message || e));

  const results = await job.exec(o.offer ?? compute.marketValue);
  jsonl.end();

  const rows = [];
  for (const r of Array.from(results)) {
    for (const f of r.files) {
      if (f.error) { rows.push({ id: f.id, label: f.label, error: f.error }); continue; }
      for (const c of f.conditions) {
        rows.push({
          id: f.id, label: f.label, snr: c.snr, seed: c.seed, windows: c.margins.length,
          first: c.first.toFixed(4), min: c.min.toFixed(4), mean: c.mean.toFixed(4), prediction: c.prediction,
          correct: f.label ? String(f.label === c.prediction) : '',
        });
      }
    }
  }
  fs.writeFileSync(prefix + '.csv', toCsv(rows));
  const scored = rows.filter((r) => r.correct);
  const right = scored.filter((r) => r.correct === 'true').length;
  console.log(`\n${rows.length} rows -> ${prefix}.csv  (${((Date.now() - t0) / 1000).toFixed(0)} s wall)`);
  if (scored.length) console.log(`accuracy on labelled rows: ${right}/${scored.length}`);
}

require('dcp-client').init().then(main).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
