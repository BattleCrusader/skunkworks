// M6 — the accounting unit: 8 parallel byte-ranges of ONE download must consume ONE use.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const req = createRequire(process.env.SK_R2_REQUIRE || 'package.json');
const Database = req('better-sqlite3');
const P = (process.env.SK_R2_BASE || '/tmp/sk-r2sec') + '/jti.db';

if (!isMainThread) {
  const db = new Database(workerData.db);
  db.pragma('busy_timeout = 3000');
  const claim = db.transaction((jti, kind) => {
    const ins = db.prepare('INSERT INTO cms_download_event(jti, kind) VALUES(?, ?) ON CONFLICT DO NOTHING').run(jti, kind);
    let inc = 0;
    if (ins.changes === 1 && kind === 'first') {
      inc = db.prepare(`UPDATE cms_download_code SET uses = uses + 1
        WHERE id = 1 AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses)`).run().changes;
    }
    return { ins: ins.changes, inc };
  }).immediate;
  const bump = db.prepare('UPDATE cms_download_code SET uses = uses + 1 WHERE id = 1 AND uses < max_uses');
  while (Date.now() < workerData.goAt) { /* barrier */ }
  let r;
  try { r = workerData.mode === 'naive' ? { inc: bump.run().changes } : claim(workerData.jti, workerData.kind); }
  catch (e) { r = { err: e.code || e.message }; }
  db.close();
  parentPort.postMessage(r);
  process.exit(0);
}

const fresh = () => {
  fs.rmSync(P, { force: true });
  const db = new Database(P);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE cms_download_code(id INTEGER PRIMARY KEY, uses INT NOT NULL DEFAULT 0, max_uses INT, revoked_at TEXT);
           CREATE TABLE cms_download_event(jti TEXT NOT NULL, kind TEXT NOT NULL);
           CREATE UNIQUE INDEX ix_first_only ON cms_download_event(jti) WHERE kind = 'first';
           INSERT INTO cms_download_code(id, uses, max_uses) VALUES(1, 0, 3);`);
  db.close();
};
const run = (n, mode, kind, jti) => Promise.all(Array.from({ length: n }, () => new Promise((res) => {
  const w = new Worker(new URL(import.meta.url), { workerData: { db: P, goAt: Date.now() + 200, mode, kind, jti } });
  w.on('message', res); w.on('error', (e) => res({ err: e.message }));
})));
const state = () => {
  const db = new Database(P, { readonly: true });
  const c = db.prepare('SELECT uses FROM cms_download_code WHERE id=1').get().uses;
  const e = db.prepare("SELECT kind, count(*) n FROM cms_download_event GROUP BY kind").all();
  db.close(); return { uses: c, events: e };
};

fresh();
let res = await run(8, 'naive', null, null);
console.log(`naive per-request consume : 8 parallel ranges -> ${JSON.stringify(res.map((r) => r.inc))} uses=${state().uses}  (max_uses=3)`);

fresh();
res = await run(8, 'jti', 'first', 'J1');
console.log(`jti-claim, 8 parallel      : ${JSON.stringify(res)}`);
console.log(`  state after 8 ranges     : uses=${state().uses} events=${JSON.stringify(state().events)}`);

await run(8, 'jti', 'range', 'J1');
const s = state();
console.log(`  8 more Range requests    : uses=${s.uses} events=${JSON.stringify(s.events)}  <- still one redemption`);
