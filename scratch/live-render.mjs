
import { totpCode } from '../app/admin/auth.ts';
import { readFileSync, writeFileSync } from 'node:fs';
const f = readFileSync('data/enrol-abc123.txt','utf8');
const pw = /^password:\s+(.*)$/m.exec(f)[1].trim();
const secret = /^secret:\s+(.*)$/m.exec(f)[1].replace(/\s+/g,'').trim();
const base = 'https://abc123.com';
const login = await fetch(base + '/admin/login', {
  method:'POST',
  headers:{ 'content-type':'application/json', origin: base },
  body: JSON.stringify({ email:'owner@abc123.com', password: pw, totp: totpCode(secret, Date.now()) }),
});
const cookie = (login.headers.getSetCookie?.() ?? [])[0].split(';')[0];
console.log('login', login.status, '| cookie name', cookie.split('=')[0]);
for (const [name, path] of [['live-pages','/admin'], ['live-media','/admin/t/abc123/media'], ['live-signin','/admin/login']]) {
  const res = await fetch(base + path, { headers: name === 'live-signin' ? {} : { cookie } });
  const html = await res.text();
  writeFileSync(`/tmp/${name}.html`, html);
  console.log(name, res.status, html.length, 'bytes');
}
