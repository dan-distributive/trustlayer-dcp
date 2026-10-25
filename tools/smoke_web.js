#!/usr/bin/env node
/*
 * Headless smoke test of web/index.html: load sample clips, check the deploy
 * button and the worker QR panel, check for console errors, save a screenshot.
 * No npm deps: Node's WebSocket drives Chrome over the DevTools protocol.
 *
 *   node tools/smoke_web.js [http://localhost:8765/]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const URL_ = process.argv[2] || 'http://localhost:8765/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = process.argv[2] ? null : spawn('python3', ['-m', 'http.server', '8765'], { cwd: path.join(ROOT, 'web'), stdio: 'ignore' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9339', `--user-data-dir=${profile}`, '--window-size=1100,1800', 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250);
      try { target = (await (await fetch('http://127.0.0.1:9339/json')).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pending = new Map(); const errors = [];
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`);
    });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
    await send('Page.navigate', { url: URL_ });
    await sleep(3000);
    console.log('dcp-client loaded:', await evaluate('typeof dcp !== "undefined"'));
    console.log('work function loaded:', await evaluate('typeof aasistWork === "function"'));
    await evaluate('document.getElementById("samples").click()');
    for (let i = 0; i < 40 && !(await evaluate('files.length')); i++) await sleep(250);
    console.log('files:', await evaluate('document.getElementById("fileSummary").textContent'));
    console.log('plan:', await evaluate('document.getElementById("planLine").textContent'));
    console.log('deploy enabled:', await evaluate('!document.getElementById("deploy").disabled'));
    // begin() is what Deploy runs before the wallet step; call it directly to check the worker QR.
    const qr = async (key, secret) => evaluate(`(() => {
      const r = groupRows[0]; r.k.value = ${JSON.stringify(key)}; r.s.value = ${JSON.stringify(secret)};
      begin(plan()); finish();
      return { href: document.getElementById('qrLink').href, drawn: !!document.querySelector('#qrcode img, #qrcode canvas'),
               panel: !document.getElementById('runout').hidden, sub: document.getElementById('qrSub').textContent };
    })()`);
    console.log('qr, group + secret:', JSON.stringify(await qr('queens', 'test-secret')));
    console.log('qr, key only:     ', JSON.stringify(await qr('queens', '')));
    console.log('qr, public:       ', JSON.stringify(await qr('', '')));
    await qr('queens', 'test-secret');
    await evaluate(`log('state: deployed'); log('job XXXX accepted: 3 slices'); log('slice 1 done (1/3): 28 windows, 22.9 s on wasm')`);
    await evaluate('document.getElementById("runout").scrollIntoView({ block: "center" })');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(ROOT, 'results', 'web-smoke.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot:', out);
    console.log('console errors:', errors.length ? '\n  ' + errors.join('\n  ') : 'none');
    ws.close();
  } finally {
    chrome.kill(); if (server) server.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
