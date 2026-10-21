
// Real browser, real cookie, real page: drive Chrome for Testing over CDP (Node 22 has a
// global WebSocket, so no playwright is needed) and capture what the operator actually sees.
import { totpCode } from '../app/admin/auth.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CHROME = '/Users/cyberdeth/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const port = 9333;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--ignore-certificate-errors', '--allow-insecure-localhost',
  `--remote-debugging-port=${port}`, '--user-data-dir=/tmp/skw-chrome-cdp', 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));

const f = readFileSync('data/enrol-abc123.txt','utf8');
const pw = /^password:\s+(.*)$/m.exec(f)[1].trim();
const secret = /^secret:\s+(.*)$/m.exec(f)[1].replace(/\s+/g,'').trim();
const base = 'https://abc123.com';
const login = await fetch(base + '/admin/login', { method:'POST', headers:{ 'content-type':'application/json', origin: base },
  body: JSON.stringify({ email:'owner@abc123.com', password: pw, totp: totpCode(secret, Date.now()) }) });
const setCookie = (login.headers.getSetCookie?.() ?? [])[0].split(';')[0];
const [cname, cvalue] = [setCookie.slice(0, setCookie.indexOf('=')), setCookie.slice(setCookie.indexOf('=') + 1)];
console.log('login', login.status, '| cookie', cname);

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}, sessionId) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); });

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
const set = await send('Network.setCookie', { name: cname, value: cvalue, url: base, path: '/admin', secure: true, httpOnly: true, sameSite: 'Strict' }, sessionId);
console.log('setCookie', JSON.stringify(set.result));
await send('Page.navigate', { url: `${base}/admin/t/abc123/editor?page=2` }, sessionId);
await new Promise((r) => setTimeout(r, 6000));
const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
writeFileSync('/tmp/editor-real.png', Buffer.from(shot.result.data, 'base64'));
const dom = await send('Runtime.evaluate', { expression: `JSON.stringify({url: location.pathname, bar: !!document.getElementById('skw-bar'), blocks: document.querySelectorAll('#skw-blocks button').length, panels: document.querySelectorAll('.gjs-pn-btn').length, fa: document.querySelectorAll('[class*="fa fa-"]').length})`, returnByValue: true }, sessionId);
console.log('DOM', dom.result.result.value);
ws.close();
chrome.kill();
