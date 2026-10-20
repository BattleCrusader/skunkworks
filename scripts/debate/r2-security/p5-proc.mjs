// M5 — cost of the process boundary D1 forbids: spawn → first query, and peak RSS.
import { spawn } from 'node:child_process';
const CHILD = new URL('./p5-proc-child.mjs', import.meta.url).pathname;
const runs = [];
for (let i = 0; i < 10; i++) {
  const t0 = process.hrtime.bigint();
  const c = spawn(process.execPath, [CHILD], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => c.stdout.on('data', (b) => { if (String(b).includes('READY')) res(); }));
  runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  await new Promise((res) => c.on('exit', res));
}
runs.sort((a, b) => a - b);
const med = runs[Math.floor(runs.length / 2)];
console.log(`spawn -> first query answered: ${runs.map((r) => r.toFixed(0)).join(', ')} ms`);
console.log(`median ${med.toFixed(1)} ms, min ${runs[0].toFixed(1)}, max ${runs.at(-1).toFixed(1)}`);
