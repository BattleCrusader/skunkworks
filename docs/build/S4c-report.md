# S4c — the install promise, the plugin runner, and the refusals

**Tree:** `0897b08` + S4b's working tree + this slice, **uncommitted**, as instructed.
Production: `app/render/csp.ts` (new), `app/export/{index,cms,static,astro,tree}.ts`,
`app/main.ts`, `app/errors.ts`, `install.sh` (rewritten), `tools/{control_db.mjs (new),
seed_control.mjs, bundle_verify.mjs, install_check.mjs}`, `runner/**` (new),
`docker-compose.yml`, `snippets/skunk-csp.conf`, `schema/{control.seed.json,
error-codes.json}`, `nginx/conf.d/10-app.conf` (regenerated). Tests:
`test/install-bundle.test.ts`, `test/csp.test.ts`, `test/export-resilience.test.ts`,
`test/runner-contain.test.ts`, `test/perf/install-cold.perf.test.ts`, `test/helpers/{bundle,full-disk}.ts`,
`test/fixtures/{plugins/*,runner_client.mjs}`, plus five existing files that had to learn about
the new snippet and the new count. Evidence: `scratch/s4c/**`.

**Gate:** `make test` **517/517, 0 failed, 0 skipped, RC=0**. `SKW_ALLOW_SKIP` was never set; no
gate was weakened. `make test-perf`'s new install case: **1.1 s** machine.

| # | Item | Verdict | § |
|---|---|---|---|
| 1 | `install.sh` end to end against a CMS bundle, on a clean directory | **done** — 9 gates, plus one bug found and fixed | §2 |
| 2 | the five-minute promise, measured | **done** — **1.15 s machine + one 20 s human scan = 21.2 s** | §3 |
| 3 | the plugin runner, contained, + the plugin-row refusal | **done, with a named gap** — the socket and containment are proved; the app-side client is not wired | §4 |
| 4 | one CSP, four places, byte-identical | **done** — one sha256 in four places, three mutations red | §5 |
| 5 | ENOSPC and two writers, refused | **done** — real full volume, real second writer | §6 |

---

## 1 — What changed, in one paragraph

The install path stopped assuming it was running inside the source tree. It now needs **`node`
and nothing else** (`node:sqlite`, no `sqlite3` binary, no compiler, no `better-sqlite3`), it
finds a bundle's seed at `data/control.seed.json` instead of `schema/control.seed.json`, it puts
the tenant's database where the app looks for it (`<data>/tenants/<key>/site.db`), it takes its
`skwctl` from `./dist`, `--runtime DIR`, or the pinned image, and it **proves the promise
itself**: `--verify-login` logs in *and* fetches the tenant's first published page over a real
listener. The seed's `schema_version` is now read, checked against `control.sql`, and refused on
mismatch — in the verifier *and* in the seeder. The plugin runner exists as the fourth
container, and both ends of the plugin-row problem refuse: the exporter will not write a bundle
whose plugin rows have no package, and the verifier refuses one.

## 2 — Item 1: `install.sh` against a real bundle, on a clean directory

The bundle is built by the product (`runExport({target:'cms'})`), copied into a fresh directory,
and the **bundle's own** `install.sh` runs there. 15 files verify; 9 gates.

```
$ cd $CLEAN && ./install.sh --no-compose --skip-dns --runtime /…/skunkworks --verify-login
install: verify: BUNDLE.json present, checking every sha256
bundle_verify: 15 file(s) verified, no render tree, no render rows
install: schema: control.sql applied to …/data/control.db (v4)
seed_control: 1 tenant(s), 1 claim marker(s), one transaction
install: tenant: acme site.db installed from the bundle (production, active)
install: env: .env written (0600) with a fresh key per install
install: runtime: /…/skunkworks
enrolment written: …/data/first-login.txt (0600, mode O_EXCL)
install: bootstrap: enrolment written to …/data/first-login.txt (0600)
install: compose: skipped (--no-compose)
install_check: signed in as owner@acme.test, GET /admin 200 (text/html)
install_check: GET / 200 309 B "Acme home" host=acme.test
install: done. Sign in at https://admin.skw.test/admin/login, then delete …/first-login.txt.
real 1.15
```

```
$ node tools/control_db.mjs version --db data/control.db
4
$ node tools/control_db.mjs tenants --db data/control.db
acme	production	active
$ stat -f '%Sp %N' data/first-login.txt
-rw------- …/data/first-login.txt
$ ls -l data/tenants/acme/site.db
-rw-r--r--  1 cyberdeth  staff  319488 …  data/tenants/acme/site.db
```

**A second run is idempotent, not a refusal** — and it does not seed a second tenant:

```
$ ./install.sh --no-compose --skip-dns --runtime /…/skunkworks
install: schema: …/data/control.db exists, left alone
install: seed: tenants already present, left alone
install: tenant: acme site.db present, left alone
install: bootstrap: this box is already set up; nothing changed (exit 3)
real 0.17
```

`I2` asserts the stronger half: the `user_account` row is byte-identical (same `password_hash`,
same `totp_secret`) after the second run, and `count(*) FROM tenant` is still 1.

### 2.1 The stale seed, made live

`data/control.seed.json` said `schema_version: 3` while `schema/control.sql` declares
`PRAGMA user_version = 4`, and nothing read either (S4b §9.1). It now says **4**, and both
readers refuse a disagreement by name:

```
$ ./install.sh --no-compose --seed ./stale.seed.json --target data-fresh
seed_control: REFUSAL: seed schema_version 3 does not describe control.db, which is 4 — a seed
  and a schema that disagree would label one database with the other's version
install: REFUSAL: the seed did not apply
exit 15
```

and, when the stale seed is *inside* the bundle (resealed, so the hash agrees — the shape a
buggy exporter produces):

```
$ ./install.sh --no-compose
bundle_verify: REFUSAL: data/control.seed.json says schema_version 3 but schema/control.sql
  declares 4 — a bundle whose seed and schema disagree seeds a database it cannot describe
install: REFUSAL: bundle verification failed
exit 12
```

Two independent readers, before `control.db` exists in the second case. A v3 seed cannot
produce a v4-labelled database silently, and the version in the file is now the version the
gate checks rather than documentation nobody parses.

### 2.2 The verdict is honoured, not just reached

`bundle_verify` was never executed against a real bundle before this slice (no bundle existed
for the branch to fire on). It is reached, and its exit is load-bearing:

```
$ printf 'tampered\n' > EXPORT-NOTES.md && ./install.sh --no-compose
bundle_verify: REFUSAL: sha256 mismatch: EXPORT-NOTES.md
install: REFUSAL: bundle verification failed                       # exit 12
$ ls data/control.db
ls: … No such file or directory
```

### 2.3 Found while building `I7`: the exporter ate the bundle's own database

`planCms()`'s temporary `VACUUM INTO` file was `join(tmpDir, 'site.db')`. In a *bundle*, `tmpDir`
is the data directory and `data/site.db` **is the tenant's shipped database** — so re-cutting a
bundle from an installed tree overwrote that file and then deleted it:

```
$ ./install.sh --no-compose            # installed bundle, data/site.db present
$ node app/cli/export.ts --target cms --tenant acme --out recut --data-dir data
… (S4b code) then:
bundle_verify: REFUSAL: missing file: data/site.db
```

This is the normal operator action (edit the site, ship again), and nothing in S4b's gates
could see it: the export gates always used a data directory whose `site.db` is
`tenants/acme/site.db`, never the bundle's copy. The temp is now
`.export-<tenant>-<pid>.snapshot.db`, and `I7` re-cuts a bundle from an installed tree and
asserts `data/site.db` still exists and is byte-identical.

## 3 — Item 2: the five-minute promise, measured

D30's promise has two clocks, and the report says which is which:

| | time | what it is |
|---|---|---|
| machine | **1.15 s** (`real`, `/usr/bin/time -p`; 1.1 s in `test/perf/install-cold.perf.test.ts`) | verify → DDL → seed → tenant db → `.env` → bootstrap → boot → login → `GET /` 200 |
| human | **20 s** (allowance, not a measurement) | one TOTP scan in an authenticator app — the step D30 added to the promise |
| **total** | **21.2 s of 300 s** | |

The machine half on this box, run by the gate:

```
$ node --test --test-concurrency=1 test/perf/install-cold.perf.test.ts
# install-cold: machine 1.1 s + human 20 s (one TOTP scan, allowance) = 21.1 s of 300 s
ok 1 - D30 — a cold install on an empty directory reaches a served page inside the five-minute promise
```

The gate asserts machine < 120 s **and** total < 300 s: a regression that doubled the install
would still pass a bare 300 s band while the promise quietly halved on a slower box.

**What the number excludes, stated rather than implied.** No image pull, no bundle transfer, no
TLS issuance (§1.2's bracketed promise; §12.5's `certificate: pending` is allowed). And the
`skwctl` step borrowed the repository's `dist/` rather than a published image.

**The compose step, driven for real and failing for the recorded reason** — the same bundle,
without `--no-compose`:

```
$ ./install.sh --skip-dns --runtime /…/skunkworks
Image ghcr.io/skunkworks/app@sha256:0000… Interrupted
Image nginxproxy/acme-companion Interrupted
Error response from daemon: error from registry: denied
install: REFUSAL: docker compose up -d failed
exit 17
```

`docker compose pull app` alone says the same in one line: `Error error from registry: denied`.
The pinned digest does not exist here, so the fourth service's *compose* wiring is proved by
configuration and by the container gate (§4.1), not by `compose up`.

## 4 — Item 3: the plugin runner, and two refusals

### 4.1 The container

`runner/` — a `node:22-alpine` image with no package tree (`server.mjs`, `child.mjs`,
`package.json`; no `npm install`, because a runner with a dependency tree is a second supply
chain to audit). It binds `/srv/run/plugin.sock`, loads every package under `/srv/plugins/<id>/`
**at runtime** from a read-only mount, validates `plugin.json`, and spawns one
`node --permission` child per package:

```
node --permission --allow-fs-read=/srv/runner/child.mjs \
     --allow-fs-read=/srv/plugins/<id> --allow-fs-read=/srv/scratch/<id> \
     /srv/runner/child.mjs /srv/plugins/<id>/<entry>
```

No `--allow-addons`, no `--allow-child-process`, no `--allow-worker` — the flags are absent, not
false, because the absence is the control (§8.4).

`test/runner-contain.test.ts` builds it and runs it exactly as `docker-compose.yml` does:
`--network none --read-only --cap-drop ALL --pids-limit 64`, one package tree ro, one socket
dir, one scratch dir.

```
$ node --test --test-concurrency=1 test/runner-contain.test.ts
ok 1 - R1 — the container has no network namespace, no ports, a read-only root and one cgroup
ok 2 - R2 — the packages load at runtime from outside the source tree, and report themselves
ok 3 - R3 — a declared op is answered by the runner; an undeclared one is refused by name
ok 4 - R4 — a host op is authorised and then refused: the app-side client is not wired yet
ok 5 - R5 — plugin code runs in the child, and its result comes back over the socket
ok 6 - R6 — a plugin that opens a socket is refused, and the refusal names the package
ok 7 - R7 — the runner fits §8.4's cost line: one process tree under 64 MiB
# pass 7
```

R1 reads the runtime configuration back from the daemon, not from the file:

```
$ docker inspect skw-runner-s4c --format '{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.PidsLimit}}'
none true [ALL] 64
$ docker inspect skw-runner-s4c --format '{{json .NetworkSettings.Ports}}'
{}
```

### 4.2 The containment proof, and what it actually shows

A probe package (`test/fixtures/plugins/probenet`) tries four routes and a file read:

| route | result inside `--network none` | why it is the right assertion |
|---|---|---|
| TCP `1.1.1.1:53` | `ENETUNREACH` | no route off the namespace |
| UDP `1.1.1.1:53` | `ENETUNREACH` | the same for datagrams |
| `fetch('http://1.1.1.1/')` | `ENETUNREACH` | the route the SDS names first |
| TCP `127.0.0.1:8765` | `ECONNREFUSED` | loopback exists; nothing listens |
| `readFileSync('/srv/runner/server.mjs')` | `ERR_ACCESS_DENIED` | the file exists and is 0444 — **`--permission`**, not the mount, denies it |

**A finding, on the record.** `network_mode: none` still gives the container a loopback
interface, and a UDP `send()` to a loopback address is *accepted by the kernel* (`SENT`) — there
is no route to look up and nothing has to answer. My first probe asserted "no socket can be
opened" and passed for the wrong reason until the UDP case proved it wrong. The claim the gate
now makes is the true one: **no route off the namespace**, and `loopback_udp: SENT` is asserted
as a documented property rather than hidden.

The refusal names the package, which is the operational requirement:

```
runner: refusal plugin=probenet code=SKW_E_PL_PLUGIN_ERROR: SKW_E_PL_PLUGIN_ERROR: Error: …
$ … plugin.invoke probenet reach
{"id":1,"ok":true,"plugin":"probenet","result":{"external_tcp":"ENETUNREACH",…,"read":"ERR_ACCESS_DENIED"}}
```

### 4.3 Capability grant, and the gap

```
$ … {"id":1,"op":"util.now","plugin":"echo"}
{"id":1,"ok":true,"plugin":"echo","result":"2026-10-20T23:41:07.812Z"}
$ … {"id":2,"op":"store.insert","plugin":"echo"}
{"id":2,"ok":false,"plugin":"echo","code":"SKW_E_PL_REJECTED",
 "message":"store.insert is not in echo's declared capabilities"}
$ … {"id":3,"op":"store.query","plugin":"echo"}          # declared, so authorised…
{"id":3,"ok":false,"plugin":"echo","code":"SKW_E_PL_UNAVAILABLE",
 "message":"store.query needs the host client, which is not wired in this slice"}
```

**The gap, named.** The four ops that need no host (`util.now`, `util.random`, `util.hash`,
`log.write`) are implemented. The ten that need the host (`store.*`, `settings.*`,
`assets.resolve`, `mail.send`) are authorised against the manifest and then refused, because
`app/main.ts` step 6 still prints `plugin.sock: not bound (S4 owns the plugin runner)`. A runner
that answered `store.insert` from its own filesystem would be a second, unaudited data path;
the refusal is the honest half of the feature.

**Cost, measured** (`docker stats --no-stream`):

| configuration | RSS |
|---|---|
| idle, zero packages | 10.3 MiB |
| parent + two permission children (one cgroup) | 34.5–36.1 MiB |

Comfortably inside §8.4's 47.4–48.0 MB for the idle runner; each child adds a Node heap, and
per-plugin memory remains unenforceable inside the one cgroup (§14 R2) — unchanged.

### 4.4 The plugin-row refusal, at both ends

The exporter will not **produce** such a bundle:

```
$ node app/cli/export.ts --target cms --tenant acme --out /tmp/out --data-dir … --now …
REFUSAL: SKW_E_PL_EXPORT_PACKAGE_MISSING {"plugins":[{"id":1,"plugin":"contact","version":"1.4.0"}],
  "missing":"plugins/: this export ships no plugin code yet"}
skw-export: refused; nothing was written to /tmp/out
rc=20
```

and the installer refuses one that exists (a hand-edited or buggy-exporter bundle, resealed so
the hash agrees):

```
$ ./install.sh --no-compose
bundle_verify: REFUSAL: data/site.db: plugin contact (cms_plugin_installed row 1) has no package
  at plugins/contact/ — a plugin row without its code is a site that fails on first render
install: REFUSAL: bundle verification failed                              # exit 12
$ ls data/control.db
ls: … No such file or directory
```

Both name the plugin **and the row**. Two new codes, `SKW_E_PL_EXPORT_PACKAGE_MISSING` (exit 20)
and `SKW_E_EXP_WRITER_ACTIVE` (exit 26), moved the taxonomy 78 → 80 (`test/error-codes.test.ts`).

## 5 — Item 4: one CSP, four places

`app/render/csp.ts` holds the §10.5 policy once. Four artefacts carry it:

1. the live site's `Content-Security-Policy` header — set on the raw response before the Astro
   hijack for pages, and by an `onSend` hook for every other `text/html` reply;
2. `security-headers.conf` in the static tree;
3. the same file, byte-identical, in the Astro tree;
4. `snippets/skunk-csp.conf` in the CMS bundle, included by the generated vhost in the three
   locations nginx serves itself (`/media/`, the two `__protected/`).

```
$ for t in static astro cms; do node app/cli/export.ts --target $t --tenant acme --out scratch/s4c/export/$t \
    --data-dir $DATA --content $CONTENT --origin https://acme.test --now 2026-10-20T12:00:00.000Z; done
export: target=static … files=6  bytes=3246
export: target=astro  … files=11 bytes=135094
export: target=cms    … files=16 bytes=401045
$ shasum -a 256 scratch/s4c/export/{static,astro}/security-headers.conf \
    scratch/s4c/export/cms/snippets/skunk-csp.conf snippets/skunk-csp.conf
6dd0ec9d0a86f93bb11ce6dfef26a7d2f28facced5a2b6dfc797acfe8cc82ecf  …/static/security-headers.conf
6dd0ec9d0a86f93bb11ce6dfef26a7d2f28facced5a2b6dfc797acfe8cc82ecf  …/astro/security-headers.conf
6dd0ec9d0a86f93bb11ce6dfef26a7d2f28facced5a2b6dfc797acfe8cc82ecf  …/cms/snippets/skunk-csp.conf
6dd0ec9d0a86f93bb11ce6dfef26a7d2f28facced5a2b6dfc797acfe8cc82ecf  snippets/skunk-csp.conf
```

Four files, one hash, and the live header equals the policy those files carry (C1). C2 asserts
both sides of the `text/html` rule: the admin form carries the policy, and the §4.3 JSON 404
carries none (a JSON body has nothing to constrain).

**The mutations, because a gate that only reads one constant cannot fail for the reason it is
named:**

| mutation | gate | verdict |
|---|---|---|
| the static writer's policy drifts by one space (a second producer) | `test/csp.test.ts` C3 **and** C6 | **not ok** — "the three files differ" |
| the serve path stops setting the header | C1 | **not ok** — the served document has no policy |
| the constant changes, the checked-in snippet is not regenerated | C4 | **not ok** — "snippets/skunk-csp.conf is stale" |

Reverted: `# pass 6 # fail 0`. The honest limit, stated: four producers reading one constant
cannot *disagree* about the constant's value, so what the gate really protects is each producer
continuing to read it — which is what the first and second mutations break.

## 6 — Item 5: a full disk, and two writers

`test/export-resilience.test.ts`, on a real 1 MB HFS+ volume (`hdiutil`, unprivileged) and a
real second writer (this process holding the lock):

```
$ node --test --test-concurrency=1 test/export-resilience.test.ts
ok 1 - D1 — a full disk is refused before the write, leaving every existing byte intact
ok 2 - D2 — the writer itself, on a full volume: DiskFullError, no temporary, previous bytes intact
ok 3 - D3 — a second writer on one tenant gets a named refusal and writes nothing
ok 4 - D4 — a stale lock (holder gone) is taken over, then released: a crash is not an outage
ok 5 - D5 — the CLI maps both refusals to their §11.3 exit codes
```

```
$ node app/cli/export.ts --target static --tenant acme --out /Volumes/skwfull/out --data-dir … 
REFUSAL: SKW_E_EXP_INSUFFICIENT_DISK {"projected_bytes":303024,"free_bytes":12288,"out":"/Volumes/skwfull/out"}
skw-export: refused; nothing was written to /Volumes/skwfull/out
rc=25
$ ls /Volumes/skwfull/out
ls: … No such file or directory
```

D1 asserts the digests, not the message: a sentinel file on the volume and the tenant's
`site.db` are `sha256`-identical before and after. D2 drives `writeTree` **on** the full volume
and asserts the writer raises `DiskFullError` with the kernel's `ENOSPC`, leaves no
`.skw-tmp-*` behind, and does not rename a partial page into place — the half a precheck cannot
reach, because a precheck is a statement about a moment. D3/D4 hold the lock from a live and a
dead pid: the live holder produces `SKW_E_EXP_WRITER_ACTIVE` (exit 26) naming the tenant and the
lock path with **no output tree**, and the dead one is taken over and released.

The precheck is deliberately conservative (2× the projected logical bytes, §15.3), so on this
box the *precheck* refuses first most of the time. That is the design, and the report says
which assertion covers which path rather than letting one green tick imply both.

## 7 — What remains before S4 can be called GO

1. **The runner is not connected to the app.** `app/main.ts` step 6 still says
   `plugin.sock: not bound`; the ten host ops are refused. Plugin install → enable → render is
   not usable end to end, and `planCms()` still ships `plugins: []` for the same reason — a
   bundle with plugins is refused today, never produced.
2. **The released images do not exist here.** `docker compose pull app` returns
   `error from registry: denied` for the pinned digest, so `docker compose up` — and therefore
   `install.sh`'s last step, exit 17 — cannot be exercised on this box. The install's container
   bootstrap path (`docker compose run app node dist/app/cli/skwctl.js`) is implemented and
   **untested**. The 1.15 s number is host-side install only: no pull, no transfer, no TLS.
3. **§16 S4 rows still open**: a third-party plugin with no test report or a stale digest is
   refused (install matrix); a plugin `asset_key` delete is blocked with `foreign_keys=OFF`;
   the `cp`-built bundle fails `--verify` (S4b left this "half"); a page whose shell is unknown
   is `422` at publish; the island escaping test in a real UA.
4. **`frame-src` is `'none'` for every tenant.** The parameter exists so the four places move
   together, but per-tenant frame declarations are not implemented and no tenant setting
   carries them.
5. **The CSP has not been observed on the wire through nginx.** The app's header is asserted on
   a real listener; the generated vhost includes the snippet in the three nginx-served
   locations and the config passes `nginx -t` in the e2e fixtures, but no gate fetches a
   `/media/` response and checks the header. One curl in the existing nginx gate would close it.
6. **`install.sh` still cannot bootstrap a bundle without a runtime.** `--runtime DIR` or a
   pullable image is required; with neither, the bundle install exits 16 saying
   *"the app image could not run skwctl … a bundle install needs --runtime DIR or a pullable
   image"* (exit 19 when `--target` is not `./data`). That is honest, but it means "extract and
   run" is true only where the image is pullable — i.e. not proved here.

---

## Appendix — reproducing

```bash
# the four S4c gates
node --test --test-concurrency=1 test/install-bundle.test.ts     # 9
node --test --test-concurrency=1 test/csp.test.ts                # 6
node --test --test-concurrency=1 test/export-resilience.test.ts  # 5
node --test --test-concurrency=1 test/runner-contain.test.ts     # 7 (builds runner/)

# the promise
node --test --test-concurrency=1 --test-timeout=300000 test/perf/install-cold.perf.test.ts

# the whole gate
make test                                                        # 517/517, RC=0
```

`scratch/s4c/` holds the clean-directory install log (`install.log`), the post-install queries
(`evidence.txt`), the stale v3 seed (`stale.seed.json`), and the three exported trees with their
CSP files (`export/`). The resealed bad bundle was deleted after its refusal was recorded — it
carried an `.env` and an enrolment file, and a live TOTP secret is not evidence worth keeping. `scratch/s4c-make-test-final.log` is the full gate.

*Uncommitted by instruction.*
