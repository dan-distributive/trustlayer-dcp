/*
 * DCP work function: AASIST speech-deepfake scoring.
 *
 * Self-contained: every helper is nested inside aasistWork so DCP can ship it
 * as one function (no local job.requires, which only bundles under Node). The
 * only requires are the published ORT packages onnxruntime-dcp/dcp-wasm.js and
 * onnxruntime-dcp/dcp-ort.js.
 *
 * slice   = { items: [{ id, name?, label?, b64 }] }   raw WAV or FLAC bytes
 * modelB64  ONNX bytes, base64 (input "waveform" [n, 64600], output "logits" [n, 2])
 * plan    = { hop, maxWindows, snrs: [null | dB, ...], seeds: [int, ...] }
 * options = { ep: 'wasm' | 'webgpu', batch, aggregate: 'min' | 'mean' | 'first' }
 *
 * Safe to load with a classic <script> tag (no top-level return, one global).
 */
async function aasistWork(slice, modelB64, plan, options) {
  const SR = 16000;
  const W = 64600;
  const t0 = Date.now();
  plan = Object.assign({ hop: 16000, maxWindows: 0, snrs: [null], seeds: [42] }, plan || {});
  options = Object.assign({ ep: 'wasm', batch: 8, aggregate: 'min' }, options || {});
  progress(0);

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------- WAV ---------------- */
  function decodeWav(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
    let fmt = null, data = null;
    for (let o = 12; o + 8 <= u8.length;) {
      const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
      if (id === 'fmt ') {
        let format = dv.getUint16(body, true);
        if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
        fmt = { format, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
      } else if (id === 'data') {
        data = [body, Math.min(size, u8.length - body)];
      }
      o = body + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('WAV missing fmt or data chunk');
    const { format, channels, rate, bits } = fmt;
    const bytes = bits >> 3, frames = Math.floor(data[1] / (bytes * channels));
    const ch = Array.from({ length: channels }, () => new Float32Array(frames));
    let p = data[0];
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++, p += bytes) {
        let v;
        if (format === 3) v = bits === 64 ? dv.getFloat64(p, true) : dv.getFloat32(p, true);
        else if (format === 1) {
          if (bits === 8) v = (u8[p] - 128) / 128;
          else if (bits === 16) v = dv.getInt16(p, true) / 32768;
          else if (bits === 24) v = (((u8[p + 2] << 24) | (u8[p + 1] << 16) | (u8[p] << 8)) >> 8) / 8388608;
          else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
          else throw new Error('unsupported PCM bit depth ' + bits);
        } else throw new Error('unsupported WAV format ' + format);
        ch[c][i] = v;
      }
    }
    return { rate, channels: ch };
  }

  /* ---------------- FLAC ---------------- */
  function decodeFlac(u8) {
    let pos = 0;   // bit position
    const bit = () => (u8[pos >> 3] >> (7 - (pos++ & 7))) & 1;
    function bits(n) {
      let v = 0;
      while (n > 0) {
        const off = pos & 7, take = Math.min(8 - off, n);
        v = v * (1 << take) + ((u8[pos >> 3] >> (8 - off - take)) & ((1 << take) - 1));
        pos += take; n -= take;
      }
      return v;
    }
    const sbits = (n) => { if (!n) return 0; const v = bits(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; };
    function readUnary() {
      let n = 0;
      for (;;) {
        if ((pos & 7) === 0) {
          while (u8[pos >> 3] === 0) { n += 8; pos += 8; }
        }
        if (bit()) return n;
        n++;
      }
    }
    const tag = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (tag !== 'fLaC') throw new Error('not a FLAC file');
    pos = 32;
    let rate = 0, nch = 0, bps = 0, total = 0;
    for (let last = 0; !last;) {
      last = bit(); const type = bits(7), len = bits(24);
      if (type === 0) {
        const s = pos; bits(16); bits(16); bits(24); bits(24);
        rate = bits(20); nch = bits(3) + 1; bps = bits(5) + 1; total = bits(36);
        pos = s;
      }
      pos += len * 8;
    }
    const out = Array.from({ length: nch }, () => new Float32Array(total || 0));
    let written = 0;
    const scale = 2 ** (bps - 1);
    const FIXED = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

    function residual(buf, order, n) {
      const method = bits(2), porder = bits(4);
      const pbits = method === 0 ? 4 : 5, esc = method === 0 ? 15 : 31;
      const parts = 1 << porder;
      let i = order;
      for (let p = 0; p < parts; p++) {
        const cnt = (n >> porder) - (p === 0 ? order : 0);
        const k = bits(pbits);
        if (k === esc) {
          const rb = bits(5);
          for (let j = 0; j < cnt; j++) buf[i++] = sbits(rb);
        } else {
          for (let j = 0; j < cnt; j++) {
            const u = readUnary() * 2 ** k + bits(k);
            buf[i++] = u % 2 ? -(u + 1) / 2 : u / 2;
          }
        }
      }
    }
    function subframe(n, sbps) {
      bit();
      const type = bits(6);
      let wasted = 0;
      if (bit()) wasted = readUnary() + 1;
      const eb = sbps - wasted;
      const buf = new Float64Array(n);
      if (type === 0) { buf.fill(sbits(eb)); }
      else if (type === 1) { for (let i = 0; i < n; i++) buf[i] = sbits(eb); }
      else if (type >= 8 && type <= 12) {
        const order = type - 8;
        for (let i = 0; i < order; i++) buf[i] = sbits(eb);
        residual(buf, order, n);
        const c = FIXED[order];
        for (let i = order; i < n; i++) {
          let s = 0;
          for (let j = 0; j < order; j++) s += c[j] * buf[i - 1 - j];
          buf[i] += s;
        }
      } else if (type >= 32) {
        const order = type - 31;
        for (let i = 0; i < order; i++) buf[i] = sbits(eb);
        const prec = bits(4) + 1, shift = sbits(5);
        const coef = [];
        for (let i = 0; i < order; i++) coef.push(sbits(prec));
        residual(buf, order, n);
        const div = 2 ** shift;
        for (let i = order; i < n; i++) {
          let s = 0;
          for (let j = 0; j < order; j++) s += coef[j] * buf[i - 1 - j];
          buf[i] += Math.floor(s / div);
        }
      } else throw new Error('reserved FLAC subframe type ' + type);
      if (wasted) for (let i = 0; i < n; i++) buf[i] *= 2 ** wasted;
      return buf;
    }

    const BS = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
    while ((pos >> 3) + 2 < u8.length) {
      pos = (pos + 7) & ~7;
      if (!(u8[pos >> 3] === 0xff && (u8[(pos >> 3) + 1] & 0xfc) === 0xf8)) { pos += 8; continue; }
      pos += 16;
      const bsCode = bits(4), srCode = bits(4), chCode = bits(4), ssCode = bits(3); bit();
      // UTF-8 style frame/sample number
      let first = bits(8), extra = 0;
      while (first & 0x80) { extra++; first = (first << 1) & 0xff; }
      for (let i = 1; i < extra; i++) bits(8);
      let n = BS[bsCode];
      if (bsCode === 6) n = bits(8) + 1;
      else if (bsCode === 7) n = bits(16) + 1;
      if (srCode === 12) bits(8); else if (srCode === 13 || srCode === 14) bits(16);
      bits(8);   // CRC-8
      const fbps = [0, 8, 12, 0, 16, 20, 24, 32][ssCode] || bps;
      const chans = chCode < 8 ? chCode + 1 : 2;
      const sub = [];
      for (let c = 0; c < chans; c++) {
        const side = (chCode === 8 && c === 1) || (chCode === 9 && c === 0) || (chCode === 10 && c === 1);
        sub.push(subframe(n, fbps + (side ? 1 : 0)));
      }
      if (chCode === 8) for (let i = 0; i < n; i++) sub[1][i] = sub[0][i] - sub[1][i];
      else if (chCode === 9) for (let i = 0; i < n; i++) sub[0][i] += sub[1][i];
      else if (chCode === 10) for (let i = 0; i < n; i++) {
        const side = sub[1][i], mid = sub[0][i] * 2 + (side & 1);
        sub[0][i] = (mid + side) / 2; sub[1][i] = (mid - side) / 2;
      }
      pos = (pos + 7) & ~7;
      pos += 16;   // CRC-16
      for (let c = 0; c < nch; c++) {
        if (out[c].length < written + n) { const g = new Float32Array(Math.max(written + n, out[c].length * 2)); g.set(out[c]); out[c] = g; }
        for (let i = 0; i < n; i++) out[c][written + i] = sub[c][i] / scale;
      }
      written += n;
    }
    return { rate, channels: out.map((c) => c.subarray(0, written)) };
  }

  /* ---------------- mono + resample (scipy.signal.resample_poly) ---------------- */
  function mono(channels) {
    if (channels.length === 1) return channels[0];
    const n = channels[0].length, out = new Float32Array(n);
    for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i];
    for (let i = 0; i < n; i++) out[i] /= channels.length;
    return out;
  }
  function besselI0(x) {
    let s = 1, t = 1;
    for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; }
    return s;
  }
  function resamplePoly(x, from, to) {
    if (from === to) return x;
    const gcd = (a, b) => (b ? gcd(b, a % b) : a), g = gcd(from, to);
    const up = to / g, down = from / g, maxr = Math.max(up, down);
    const half = 10 * maxr, L = 2 * half + 1, fc = 1 / maxr, beta = 5;
    const h = new Float64Array(L), i0b = besselI0(beta);
    let sum = 0;
    for (let k = 0; k < L; k++) {
      const m = k - half, sinc = m === 0 ? 1 : Math.sin(Math.PI * fc * m) / (Math.PI * fc * m);
      const r = (2 * k) / (L - 1) - 1;
      h[k] = fc * sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
      sum += h[k];
    }
    for (let k = 0; k < L; k++) h[k] *= up / sum;
    const nOut = Math.ceil((x.length * up) / down), y = new Float32Array(nOut);
    for (let m = 0; m < nOut; m++) {
      const n = m * down + half;   // position in the upsampled signal, delay-compensated
      let acc = 0;
      for (let k = n % up; k < L; k += up) {
        const xi = (n - k) / up;
        if (xi >= 0 && xi < x.length) acc += h[k] * x[xi];
      }
      y[m] = acc;
    }
    return y;
  }

  /* ---------------- windows ---------------- */
  function windows(x) {
    if (x.length <= W) {
      const w = new Float32Array(W);
      for (let i = 0; i < W; i++) w[i] = x[i % x.length];
      return [{ start: 0, data: w }];
    }
    const starts = [];
    for (let s = 0; s + W <= x.length; s += plan.hop) starts.push(s);
    if (starts[starts.length - 1] + W < x.length) starts.push(x.length - W);
    const keep = plan.maxWindows > 0 ? starts.slice(0, plan.maxWindows) : starts;
    return keep.map((s) => ({ start: s, data: x.slice(s, s + W) }));
  }

  /* ---------------- seeded white noise ---------------- */
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function rng(seedStr) {
    let s = hash32(seedStr);
    const sm = () => { s = (s + 0x9e3779b9) | 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
    let a = sm(), b = sm(), c = sm(), d = sm();
    const next = () => {   // xoshiro128**
      const r = Math.imul(((Math.imul(b, 5) << 7) | (Math.imul(b, 5) >>> 25)), 9) >>> 0;
      const t = b << 9;
      c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
      return (r + 0.5) / 4294967296;
    };
    let spare = null;
    return () => {   // Box-Muller
      if (spare !== null) { const v = spare; spare = null; return v; }
      const r = Math.sqrt(-2 * Math.log(next())), th = 2 * Math.PI * next();
      spare = r * Math.sin(th);
      return r * Math.cos(th);
    };
  }
  function addNoise(x, snr, seedStr) {
    let p = 0;
    for (let i = 0; i < x.length; i++) p += x[i] * x[i];
    p /= x.length;
    if (p === 0) return null;
    const g = rng(seedStr), n = new Float64Array(x.length);
    let pn = 0;
    for (let i = 0; i < x.length; i++) { n[i] = g(); pn += n[i] * n[i]; }
    const k = Math.sqrt(p / (10 ** (snr / 10) * (pn / x.length)));
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] + n[i] * k;
    return y;
  }

  /* ---------------- ORT session, cached per sandbox ---------------- */
  require('dcp-wasm.js');
  if (!globalThis.ort) globalThis.ort = require('dcp-ort.js');
  ort.env.wasm.simd = true;
  const modelKey = modelB64.length + ':' + modelB64.slice(0, 64) + modelB64.slice(-64);
  let ep = options.ep === 'webgpu' && typeof navigator !== 'undefined' && navigator.gpu ? 'webgpu' : 'wasm';
  if (!globalThis.aasistSession || globalThis.aasistSession.key !== modelKey || globalThis.aasistSession.ep !== ep) {
    const session = await ort.InferenceSession.create(b64ToBytes(modelB64).buffer, {
      executionProviders: [ep], graphOptimizationLevel: 'all',
    });
    globalThis.aasistSession = { key: modelKey, ep, session };
  }
  const session = globalThis.aasistSession.session;
  const tSession = Date.now() - t0;
  progress(0.05);

  /* ---------------- score the slice ---------------- */
  const conds = [];
  for (const snr of plan.snrs) {
    if (snr === null || snr === undefined) conds.push({ snr: null, seed: null });
    else for (const seed of plan.seeds) conds.push({ snr, seed });
  }
  const jobs = [];   // one entry per (file, condition, window)
  const files = [];
  for (const item of slice.items) {
    const f = { id: item.id, name: item.name, label: item.label };
    files.push(f);
    try {
      const tDec = Date.now();
      const u8 = b64ToBytes(item.b64);
      const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
      const dec = magic === 'fLaC' ? decodeFlac(u8) : decodeWav(u8);
      const x = resamplePoly(mono(dec.channels), dec.rate, SR);
      const wins = windows(x);
      Object.assign(f, {
        format: magic === 'fLaC' ? 'flac' : 'wav', sourceRate: dec.rate, sourceChannels: dec.channels.length,
        seconds: +(x.length / SR).toFixed(3), windowStarts: wins.map((w) => +(w.start / SR).toFixed(3)),
        decodeMs: Date.now() - tDec, conditions: conds.map((c) => ({ snr: c.snr, seed: c.seed, margins: [], synthetic: [], genuine: [] })),
      });
      conds.forEach((c, ci) => wins.forEach((w, wi) => jobs.push({ f, ci, wi, w, c })));
    } catch (e) {
      f.error = String(e && e.message || e);
    }
  }

  let done = 0;
  const tInfer = Date.now();
  for (let b = 0; b < jobs.length; b += options.batch) {
    const batch = jobs.slice(b, b + options.batch);
    const input = new Float32Array(batch.length * W);
    batch.forEach((j, k) => {
      const data = j.c.snr === null ? j.w.data : (addNoise(j.w.data, j.c.snr, `${j.f.name || j.f.id}|${j.w.start}|${j.c.snr}|${j.c.seed}`) || j.w.data);
      input.set(data, k * W);
    });
    const out = await session.run({ waveform: new ort.Tensor('float32', input, [batch.length, W]) });
    const logits = out.logits.data;
    batch.forEach((j, k) => {
      const cond = j.f.conditions[j.ci];
      cond.synthetic[j.wi] = logits[2 * k];
      cond.genuine[j.wi] = logits[2 * k + 1];
      cond.margins[j.wi] = logits[2 * k + 1] - logits[2 * k];
    });
    done += batch.length;
    progress(0.05 + 0.95 * done / jobs.length);
  }

  for (const f of files) {
    if (f.error) continue;
    for (const c of f.conditions) {
      const m = c.margins;
      c.first = m[0];
      c.min = Math.min(...m);
      c.mean = m.reduce((a, v) => a + v, 0) / m.length;
      c.prediction = c[options.aggregate] > 0 ? 'genuine' : 'synthetic';
    }
  }
  progress(1);
  return {
    files,
    env: { ep, windows: jobs.length, sessionMs: tSession, inferMs: Date.now() - tInfer, totalMs: Date.now() - t0 },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { aasistWork };
