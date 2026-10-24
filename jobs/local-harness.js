#!/usr/bin/env node
/*
 * Run aasist-work.js the way the sandbox does, without DCP: the function is
 * rebuilt from its source text with a require() that maps the two published
 * ORT package names onto a local onnxruntime-web.
 *
 *   node jobs/local-harness.js [--check test-audio/reference.json] [--snrs null,20,10,0] files...
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ORT_WEB = process.env.ORT_WEB || path.join(process.env.HOME, 'DCP/distributed-pipelining/node_modules/onnxruntime-web');

function sandboxed() {
  const src = fs.readFileSync(path.join(__dirname, 'aasist-work.js'), 'utf8');
  const ort = require(ORT_WEB);
  ort.env.wasm.numThreads = 1;
  const req = (name) => {
    if (name === 'dcp-ort.js') return ort;
    if (name === 'dcp-wasm.js') return {};
    throw new Error('Module is not available: ' + name);
  };
  globalThis.progress = () => true;
  return new Function('require', 'module', src + '\nreturn aasistWork;')(req, undefined);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const check = opt('--check', null);
  const snrs = opt('--snrs', 'null').split(',').map((s) => (s === 'null' ? null : Number(s)));
  const files = args;
  const work = sandboxed();
  const modelB64 = fs.readFileSync(path.join(ROOT, 'models/aasist.onnx')).toString('base64');
  const slice = { items: files.map((f) => ({ id: path.basename(f), b64: fs.readFileSync(f).toString('base64') })) };
  const out = await work(slice, modelB64, { snrs, seeds: [42] }, { batch: 8 });
  const ref = check ? JSON.parse(fs.readFileSync(check, 'utf8')) : null;
  let worst = 0;
  for (const f of out.files) {
    if (f.error) { console.log(`${f.id}: ERROR ${f.error}`); worst = Infinity; continue; }
    for (const c of f.conditions) {
      const tag = c.snr === null ? 'clean' : `${c.snr}dB`;
      let line = `${f.id.padEnd(28)} ${f.format} ${f.sourceRate}Hz x${f.sourceChannels} ${tag.padEnd(5)} ` +
        `windows ${c.margins.length}  first ${c.first.toFixed(3)} min ${c.min.toFixed(3)} -> ${c.prediction}`;
      if (ref && c.snr === null) {
        const r = ref[f.id];
        const d = Math.max(...c.margins.map((m, i) => Math.abs(m - r.margins[i])));
        worst = Math.max(worst, d);
        line += `  |d| ${d.toExponential(1)}`;
      }
      console.log(line);
    }
  }
  console.log(JSON.stringify(out.env));
  if (ref) console.log(`max margin difference vs Python reference: ${worst.toExponential(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
