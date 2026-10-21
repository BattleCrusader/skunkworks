
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

const [st, html] = await get('/admin/t/abc123/editor?page=2');
const [, css] = await get('/admin/t/abc123/editor/grapesjs.css');
const [, gjs] = await get('/admin/t/abc123/editor/grapesjs.js');
const [, ed] = await get('/admin/t/abc123/editor/editor.js');
console.log('editor', st, '| page', html.length, 'B | css', css.length, '| gjs', gjs.length, '| boot', ed.length);
console.log('toolbar present:', /id="skw-bar"/.test(html), '| save button:', /id="skw-save"/.test(html), '| fa classes:', /class="fa fa-/.test(html));

// Harness: identical markup + scripts inlined, so file:// has no CSP and no cookie needed.
let out = html
  .replace(/<link rel="stylesheet" href="[^"]*grapesjs\.css">/, '<style>' + css + '</style>')
  .replace(/<script src="[^"]*grapesjs\.js"><\/script>/, '<script>' + gjs + '</script>')
  .replace(/<script src="[^"]*editor\.js"><\/script>/, '<script>' + ed + '</script>');
writeFileSync('/tmp/editor-live.html', out);
console.log('harness', out.length, 'B');
