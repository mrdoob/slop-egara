// tools/browser-smoke.mjs — loads the simulator in headless Chrome over the DevTools protocol, waits for the city to
// finish building, dumps the console and takes screenshots (NEXT_STEPS.md §2.9: the "prueba de humo en navegador").
// No npm dependencies: Node's own WebSocket client talks to Chrome. The page loads three.js from jsDelivr & Inter from
// Google Fonts as always (index.html).
//
// usage: node tools/browser-smoke.mjs [--url http://127.0.0.1:8123/] [--out dir] [--wait 240] [--chrome path]
//        [--teleport "x,z,heading[,mode]" ...] [--eval "js"]
// A static server must already serve the repo root at --url (python3 -m http.server 8123).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
// --teleport, --eval and --shot run in the order given (a teleport also takes a screenshot; --shot takes one on
// demand, e.g. after an --eval that changed the camera or the vehicle); --settle is the pause after each step (s)
const opt = { url: 'http://127.0.0.1:8123/', out: '.', wait: 240, chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', steps: [], port: 9333, settle: 3.5 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--url') opt.url = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--wait') opt.wait = Number(args[++i]);
  else if (a === '--chrome') opt.chrome = args[++i];
  else if (a === '--port') opt.port = Number(args[++i]);
  else if (a === '--settle') opt.settle = Number(args[++i]);
  else if (a === '--teleport') opt.steps.push(['teleport', args[++i]]);
  else if (a === '--eval') opt.steps.push(['eval', args[++i]]);
  else if (a === '--shot') opt.steps.push(['shot', args[++i]]);
}
fs.mkdirSync(opt.out, { recursive: true });
fs.writeFileSync(path.join(opt.out, 'smoke-console.txt'), '');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-chrome-'));
const chrome = spawn(opt.chrome, [
  '--headless=new', `--remote-debugging-port=${opt.port}`, `--user-data-dir=${profile}`, '--window-size=1600,900',
  '--enable-unsafe-webgpu', '--use-angle=metal', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
const log = (...a) => console.log('[smoke]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let k = 0; k < 50; k++) {
    try {
      const res = await fetch(`http://127.0.0.1:${opt.port}/json`, { signal: AbortSignal.timeout(2000) });
      return await res.json();
    } catch { await sleep(200); }
  }
  throw new Error('Chrome did not open its DevTools port');
}

let id = 0;
const pending = new Map();
const listeners = [];
let ws;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const console_ = [];
const errors = [];

try {
  log('chrome pid', chrome.pid);
  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  log('target', page?.webSocketDebuggerUrl);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.onopen = r; ws.onerror = (ev) => e(new Error('websocket error')); setTimeout(() => e(new Error('websocket timeout')), 10000); });
  log('connected');
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      console_.push(`${m.params.type}: ${text}`);
      fs.appendFileSync(path.join(opt.out, 'smoke-console.txt'), `${m.params.type}: ${text}\n`);
      if (m.params.type === 'error') errors.push(text);
      for (const l of listeners) l(text);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      const text = `${d.text} ${d.exception?.description || ''}`;
      console_.push(`exception: ${text}`);
      errors.push(text);
      for (const l of listeners) l(text);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const waitFor = (re, ms) => new Promise((resolve) => {
    const t = setTimeout(() => { listeners.splice(listeners.indexOf(l), 1); resolve(false); }, ms);
    const l = (text) => { if (re.test(text)) { clearTimeout(t); listeners.splice(listeners.indexOf(l), 1); resolve(true); } };
    listeners.push(l);
  });
  const ready = waitFor(/\[init\]|init complete|initTimings|\[app\] ready|Uncaught|exception/i, opt.wait * 1000);
  log('loading', opt.url);
  await send('Page.navigate', { url: opt.url });
  const ok = await ready;
  log(ok ? 'init reported' : `no init message within ${opt.wait} s`);
  await sleep(4000);
  const shot = async (name) => {
    log('capturing', name);
    const { data } = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), 60000))]);
    const file = path.join(opt.out, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    log('screenshot', file);
  };
  await shot('smoke-0.png');
  let n = 1;
  for (const [kind, arg] of opt.steps) {
    if (kind === 'teleport') {
      const [x, z, heading, mode = 'car'] = arg.split(',').map((v) => v.trim());
      const xArg = Number.isFinite(Number(x)) ? Number(x) : JSON.stringify(x); // a number, or a TELEPORT_LOCATIONS key
      const expr = `window.__slop ? window.__slop.teleport(${xArg}, ${Number(z) || 0}, ${Number(heading) || 0}, ${JSON.stringify(mode)}) : 'no window.__slop hook'`;
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      log('teleport', arg, '->', JSON.stringify(r.result?.value ?? r.exceptionDetails?.text));
      await sleep(opt.settle * 1000);
      await shot(`smoke-${n++}.png`);
    } else if (kind === 'eval') {
      const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
      log('eval', arg, '->', JSON.stringify(r.result?.value ?? r.exceptionDetails?.text));
      await sleep(opt.settle * 1000);
    } else if (kind === 'shot') {
      await shot(arg.endsWith('.png') ? arg : `${arg}.png`);
    }
  }

  log(`${console_.length} console lines, ${errors.length} errors -> ${path.join(opt.out, 'smoke-console.txt')}`);
  for (const e of errors.slice(0, 10)) log('ERROR', e.slice(0, 400));
} finally {
  try { ws?.close(); } catch { /* closing */ }
  chrome.kill('SIGKILL');
  fs.rmSync(profile, { recursive: true, force: true });
}
