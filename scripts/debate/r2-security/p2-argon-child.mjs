// argon2id child: N concurrent verifies at the given params. Prints one machine-readable line.
import { createRequire } from 'node:module';
const req = createRequire(process.env.SK_R2_REQUIRE || 'package.json');
const { hash, verify, Algorithm } = req('@node-rs/argon2');
const N = Number(process.argv[2] ?? 8);
const m = Number(process.argv[3] ?? 19456);
const t = Number(process.argv[4] ?? 2);
const p = Number(process.argv[5] ?? 1);
const opts = { memoryCost: m, timeCost: t, parallelism: p, algorithm: Algorithm.Argon2id };
const codes = Array.from({ length: N }, (_, i) => 'CODE' + String(i).padStart(8, '0'));
const digests = [];
for (const c of codes) digests.push(await hash(c, opts));
const t0 = process.hrtime.bigint();
const res = await Promise.all(digests.map((d, i) => verify(d, codes[i], opts)));
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(JSON.stringify({ N, m, t, p, allOk: res.every(Boolean), wallMs: +ms.toFixed(1), perOpMs: +(ms / N).toFixed(1) }));
