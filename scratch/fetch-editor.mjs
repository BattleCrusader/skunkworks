
import { totpCode } from '../app/admin/auth.ts';
import { readFileSync, writeFileSync } from 'node:fs';
const f = readFileSync('data/enrol-abc123.txt','utf8');
const pw = /^password:\s+(.*)$/m.exec(f)[1].trim();
const secret = /^secret:\s+(.*)$/m.exec(f)[1].replace(/\s+/g,'').trim();
const base = 'https://abc123.com';
const login = await fetch(base + '/admin/login', { method:'POST', headers:{ 'content-type':'application/json', origin: base },
  body: JSON.stringify({ email:'owner@abc123.com', password: pw, totp: totpCode(secret, Date.now()) }) });
const cookie = (login.headers.getSetCookie?.() ?? [])[0].split(';')[0];
const res = await fetch(base + '/admin/t/abc123/editor?page=2', { headers: { cookie } });
const html = await res.text();
writeFileSync('/tmp/live-editor.html', html);
console.log('editor', res.status, html.length, 'bytes');
for (const [k,v] of res.headers) if (k.startsWith('content-security')) console.log('CSP:', v.slice(0,300));
