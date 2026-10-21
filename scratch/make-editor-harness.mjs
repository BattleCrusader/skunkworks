
import { totpCode } from '../app/admin/auth.ts';
import { readFileSync, writeFileSync } from 'node:fs';
const f = readFileSync('data/enrol-abc123.txt','utf8');
const pw = /^password:\s+(.*)$/m.exec(f)[1].trim();
const secret = /^secret:\s+(.*)$/m.exec(f)[1].replace(/\s+/g,'').trim();
const base = 'https://abc123.com';
const login = await fetch(base + '/admin/login', { method:'POST', headers:{ 'content-type':'application/json', origin: base },
  body: JSON.stringify({ email:'owner@abc123.com', password: pw, totp: totpCode(secret, Date.now()) }) });
const cookie = (login.headers.getSetCookie?.() ?? [])[0].split(';')[0];
const get = async (p) => { const r = await fetch(base + p, { headers: { cookie } }); return [r.status, await r.text()]; };

let [st, html] = await get('/admin/t/abc123/editor?page=2');
const [cssSt, css] = await get('/admin/t/abc123/grapesjs.css');
const [gjsSt, gjs] = await get('/admin/t/abc123/grapesjs.js');
const [edSt, ed] = await get('/admin/t/abc123/editor.js');
console.log('assets', st, cssSt, gjsSt, edSt, '| css', css.length, 'gjs', gjs.length, 'editor', ed.length);

// A local harness: identical markup and scripts, no CSP (file:// has none).
let out = html
  .replace(/<link rel="stylesheet" href="[^"]*grapesjs\.css">/, '<style>' + css + '</style>')
  .replace(/<script src="[^"]*grapesjs\.js"><\/script>/, '<script>' + gjs + '</script>')
  .replace(/<script src="[^"]*editor\.js"><\/script>/, '<script>' + ed + '</script>');
writeFileSync('/tmp/editor-harness.html', out);
console.log('harness written', out.length);

// and the raw markup the browser receives, for the button inventory
writeFileSync('/tmp/live-editor.html', html);
