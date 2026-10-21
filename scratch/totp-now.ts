
import { totpCode } from '../app/admin/auth.ts';
const s = {
  'abc123.com': 'W335O3HJMP2OA4DNT5TSXM3LK4SGLEWH',
  'demo.abc123.com': 'UU7XVAY7BZV7AILWVTG7XTSGMGBUWX5S',
  '123abc.com': 'B3OLQBFUBBYKMUKNII2WRFTPMIQMHRLX',
};
const now = Date.now();
for (const [host, secret] of Object.entries(s)) {
  const left = 30 - Math.floor((now/1000) % 30);
  console.log(host.padEnd(20), totpCode(secret, now), `(expires in ${left}s)`);
}
