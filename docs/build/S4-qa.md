# S4 QA — the slice, the gates, and what the containment actually holds

**Verdict: NO-GO.** Five blockers (one of them a §16 row that simply does not exist), one §16 row
that cannot be gated on this box, and a cold-install defect that stops nginx from starting. The
534-test gate is real and green; it is aimed one step to the side of the first thing a customer
does.

**Tree:** `aaff12b` (`S4d: plugin runner ships packages; harness repaired; tree green at 534`).
`git status` after every mutation and restore: `?? docs/build/STATUS.md`, `?? scratch/s4-qa/` —
no tracked file modified. Every mutation below was restored and proved by sha256.
**Date:** 2026-10-21, 04:00–04:2x AEDT. **Box:** macOS 15.7.4, 8 CPUs, Docker 29.7.2
(4-CPU/1.54 GB Linux VM), node 22.23.1.

---

## 1. The gate, run three times — plus a post-restore run

Logs: `scratch/s4-qa/make-test-{1,2,3,4-post-restore}.log`. `/usr/bin/time -p make test`, full
output captured, counts from the TAP tail and the shell's `$?`.

| run | tests | pass | fail | skipped | exit | wall |
|---|---|---|---|---|---|---|
| 1 | 534 | 534 | 0 | 0 | **0** | 141.31 s |
| 2 | 534 | 534 | 0 | 0 | **0** | 134.01 s |
| 3 | 534 | 534 | 0 | 0 | **0** | 125.95 s |
| 4 (after every mutation was restored) | 534 | 534 | 0 | 0 | **0** | 129.20 s |

`make verify-dist` alone: **6/6 passed, exit 0, 5.66 s** (`scratch/s4-qa/verify-dist.log`);
D1–D6 each printed the site it executes.

`make test-perf` alone: **REFUSED, exit 2, 4.46 s** (`scratch/s4-qa/test-perf.log`):

```
make test-perf: PERFORMANCE GATE — wall-clock assertions, not correctness
  box: 8 cpus, 1-min load average 10.72
  REFUSED: load 10.72 on 8 cpus — this box is oversubscribed, and a
  busy box makes a wall-clock gate red for its own reasons.
```

The load average was 10–14 throughout (Docker Desktop's VM and `sysmond` were the top two
consumers), so the performance gate **did not run** and none of its numbers can be quoted as a
pass. I ran its install row alone (it is a measurement, not a timing assertion at the edge) and
label it below as such.

No skip was set: `SKW_ALLOW_SKIP` and `SKW_SKIP_DOCKER` are absent from the environment.

---

## 2. §16 S4 — every acceptance row

The command column is the command I ran. `run-node-tests.mjs` is the suite's own runner (a skip is
a failure). Rows 1, 3–11 are in `scratch/s4-qa/rows-1.log` (46/46) and `rows-2.log` (13/13).

| # | §16 S4 acceptance criterion | command | observed | verdict |
|---|---|---|---|---|
| 1 | every fixture page reaches `canon(load(save(load))) == canon(load)`; 9 fixtures | `node scripts/run-node-tests.mjs --timeout=40000 test/roundtrip.test.ts` | 6/6, incl. RT-1 "all nine fixtures reach the fixpoint on bytes the save route stored"; RT-0 asserts the corpus is 9 | **PASS** |
| 2 | a `list` with two `[data-repeat]` children is refused at save | no test exists; I drove the real `savePage()`: `node scratch/s4-qa/two-repeat.mts` | **ACCEPTED**: both children became row templates, `items.list` positions 0 and 1, HTTP-equivalent success. No validator test anywhere (`grep 'two \[data-repeat\]\|exactly one' test` → none) | **FAIL** |
| 3 | unknown page shell is `422 SKW_E_RT_TEMPLATE_UNKNOWN` at publish | `… test/editor-save.test.ts` | 11/11; S10 asserts the code, `HTTP[...] = 422`, and that a real shell publishes | **PASS** |
| 4 | CSP header byte-identical in all three targets | `… test/csp.test.ts` | 6/6; C3 hashes the three shipped policy files, one hash; C1/C2 the live header; C5 the three nginx includes | **PASS** |
| 5 | three targets from one generator and one projection; diff the projection digests | `… test/export-projection.test.ts` | 8/8; P7 "the three targets carry one `projection_sha`, and it is the same number in all three trees" | **PASS** |
| 6 | two exports at one `SKW_EXPORT_NOW` byte-identical; at two clocks not | `… test/export-determinism.test.ts` + my own three-target export and independent hash (§6) | 9/9; D1 all three targets, D2 all three, D3 pinned mtimes, D4 one clock; my hashes agree | **PASS** |
| 7 | a `free` parameter in a link refuses with exit 22 | `… test/export-projection.test.ts` | P4 `refusal.exit === 22`, `SKW_E_EXP_PARAMETERISED`, naming source and link | **PASS** |
| 8 | a `cp`-built bundle fails `--verify`, a `VACUUM INTO` one passes | `… test/bundle-verify.test.ts` | 6/6; B6 is exactly the pair (live-WAL `cp` → exit 12; `VACUUM INTO` → exit 0) | **PASS** |
| 9 | no bundle contains `control.db`, `-wal`, `-shm`, `content/protected/wm/`, `content/sources/` | `… test/export-targets.test.ts`; `find scratch/s4-qa/bundle …` | T4 asserts all five classes; my real bundle (19 files the verifier hashes; the exporter counts 20 including the manifest) has none — it has `data/site.db`, which the row permits | **PASS** |
| 10 | third-party plugin with no test report refused; stale digest refused | `… test/plugin-host.test.ts`; `skwctl plugin install` with a report for the untampered bytes | P1 refuses missing report, another runner image, revoked root, and installs the positive control; my tampered package → `PLUGIN_REFUSED: SKW_E_PL_TESTS_STALE: the test report is for a different package root — the bytes changed after the test run`, exit 1 | **PASS** |
| 11 | a plugin `asset_key` delete is blocked with `foreign_keys=OFF` | `… test/plugin-host.test.ts` | P2 asserts the guard and the registry row, then **drops the guard** and shows the same delete leaves a dangling key — both halves, so the gate has teeth | **PASS** |
| 12 | install on a clean host: ≤ 5 min **with images present**, `certificate: pending` allowed | `make test-perf` (refused); `… test/perf/install-cold.perf.test.ts` run alone; my own cold install (§5) | Time half green: **1.3 s + 20 s = 21.3 s of 300 s**; my install 1.25 s and a served page. But every gate passes `--no-compose`, the pinned image does not exist here (`compose up` exits 17, registry denied), and no test sets a pending certificate — in fact **the bundle's own nginx config cannot start** (§8, defect 1) | **NOT COVERED** |

**NOT COVERED: 1 of 12** (row 12's composed half). **FAIL: 1 of 12** (row 2 — the behaviour is
absent, not merely untested).

---

## 3. Negative controls — five, each broken and restored by hash

All are real tree mutations, run against the suite's own runner, then restored with `cp` and
compared by sha256. No mutation was committed.

| # | control | mutation | red evidence | restore |
|---|---|---|---|---|
| 1 | export shares the site's render path | `app/render/body.ts`: `return renderBody(db, document);` → `return document;` | `scratch/s4-qa/nc1-export-path.log`: **exit 1, 4 fail / 1 pass** — T0 the served page, T1 static, T2 Astro, T3 bundle boot all `not ok` ("the image lost its derived URL"); T4 stays green | before = after = `5cdc1b09ffd04285fa99b0a9630dafea2933558dccf1931b74750e8cb0689166` |
| 2 | the fixpoint gate drives the production save route | `app/editor/save.ts`: `const document = unwrapBody(input.html);` → `input.html` | `nc2-fixpoint.log`: **exit 1, 4 fail / 2 pass** — RT-1, RT-13, RT-2, RT-11 red; RT-1's message names the wrapper | `9ea88d58ef895ff1b47875f35a2ee342202dda7307260428d1edf7d11d70cf07` |
| 3 | the occurrence-scoped register | append `const qaScratchSite = join(process.cwd(), "qa-scratch");` to `app/main.ts` | `nc3-register.log`: **exit 1, 2 fail / 1 pass** — E28-2 names `app/main.ts:781 process.cwd() — const qaScratchSite = join(process.cwd(), "qa-scratch");`; E28-3's precondition also red | `714117d084eacc4c8e50a42f425ee984d8aac119f3f663f9645fce9c6d86cb44` |
| 4 | one-use download accounting | `app/download/ledger.ts`: `SET uses = uses + 1` → `+ 0` | `nc4-oneuse.log`: **exit 1, 9 fail / 10 pass** — R1 (8 parallel ranges), R2, R3, R3b, R3c, R13, R14, R9, R10 all red | `f1f3f2a7825d19ace2a0ac3e84084ebcb6f421c4e16fb986ceb01c330e6cac30` |
| 5 | container-leak audit | none — start `skw-qa-leak-manual` and skip its teardown | `nc5-leak-red.log`: **exit 1**, `1 skw-* resource(s) survived this run: container skw-qa-leak-manual`, and the remediation text; after `docker rm -f`, **exit 0**, "clean — 0 skw-* containers, 0 skw-* networks" | no file touched |

Control 4 is worth reading twice: one line that stops the counter makes **nine** download gates
red, so the accounting is load-bearing, not decorative.

---

## 4. Plugin containment — seven attacks, for real

Image `skw-runner:qa` built from `runner/`; the container runs exactly as compose does:
`--network none --read-only --cap-drop ALL --pids-limit 64 --security-opt no-new-privileges
--tmpfs /tmp`, one package tree `ro`, one socket dir, one scratch dir. A probe package
(`attack`, id `attack`) plus the repo's own `probenet`/`notes` are mounted. The client runs
**inside** the container (`docker exec`), the only place the socket and the netns are real.
Raw: `scratch/s4-qa/attack-*.json`.

### 4.1 Read a file outside the package

`readFileSync` of `/etc/passwd`, `/srv/runner/server.mjs`, a **sibling plugin's** `plugin.json`,
`/proc/self/environ`, and a tenant `site.db`:

```
"/etc/passwd": "ERR:ERR_ACCESS_DENIED: Access to this API has been restricted. Use --allow-fs-read …"
"/srv/runner/server.mjs": "ERR:ERR_ACCESS_DENIED: …"
"/srv/plugins/echo/plugin.json": "ERR:ERR_ACCESS_DENIED: …"
"/proc/self/environ": "ERR:ERR_ACCESS_DENIED: …"
"/srv/data/tenants/acme/site.db": "ERR:ERR_ACCESS_DENIED: …"
"cwd": "OK:/srv/runner"
"permission_fs_read": false
"binding_fs_keys": "ERR:ERR_ACCESS_DENIED: process.binding"
"spawn_cat": "ERR:ERR_ACCESS_DENIED: Access to this API has been restricted. Use --allow-child-process …"
"dlopen": "ERR:ERR_DLOPEN_DISABLED: Cannot load native addon because loading addons is disabled."
```

**Held.** `process.cwd()` is readable as a string; no file outside the two grants is. The
permission model, not the mount, is doing the work: the files exist and are 0644.

### 4.2 Exhaust memory

The container has **no memory limit**: `docker inspect` → `Memory=0 MemorySwap=0`, and inside it
`/sys/fs/cgroup/memory.max` → `max`. A 256 MB hoard held in a module global:

```
{"requested_mb":256,"held_mb":256,"rss_mb":284}
docker stats: qa-attack 321MiB / 1.435GiB 21.85%
```

**BROKEN.** A package can hold arbitrary memory until the 1.54 GB Docker VM OOMs — which takes the
app, nginx and every sibling container with it. §8.4 says "a hostile plugin can starve its
co-tenants inside the runner. **It cannot starve the host**". That sentence is false as shipped:
there is no `mem_limit` in `docker-compose.yml`, no `Memory` cap on the container, and no cgroup
maximum. 256 MB is a measurement, not the ceiling.

### 4.3 Open a socket

The repo's own `probenet` package:

```
{"external_tcp":"ENETUNREACH","external_udp":"ENETUNREACH","loopback_tcp":"ECONNREFUSED",
 "loopback_udp":"SENT","fetch_external":"ENETUNREACH","read":"ERR_ACCESS_DENIED"}
```

**Held, with the documented caveat**: no route off the namespace; loopback exists and a UDP send
to it is accepted by the kernel (reported, not hidden).

### 4.4 Call an undeclared op

Direct RPC:

```
{"id":6,"ok":false,"plugin":"attack","code":"SKW_E_PL_REJECTED",
 "message":"mail.send is not in attack's declared capabilities"}
```

Package code calling `skw.call('mail.send')` through `plugin.invoke`:

```
{"call":{"queued":true}}
```

**The runner does not enforce the manifest on host calls.** `forwardHost()` forwards whatever the
child asks for; the capability check is only on the direct-RPC branch. The *app's* host client
re-checks (`app/plugins/host.ts`, `assertEnabled` then `capabilities.includes`), and P4 proves
`store.delete` → `PL_REJECTED`. So production is safe **once**, by one line in one file; the
runner's own comment claiming the grant is enforced there is wrong. Defence in depth is absent.

### 4.5 Query another tenant's table

Through the real host op (`app/plugins/ops.ts`), with the attack manifest and a tenant database:

```
p_notes_note   REFUSED SKW_E_PL_NO_TABLE: attack did not declare table "p_notes_note"
cms_page       REFUSED SKW_E_PL_NO_TABLE: attack did not declare table "cms_page"
p_attack_note  REFUSED no such table: p_attack_note   (declared; the probe db did not install it)
```

**Held.** A table belonging to another package is refused by declaration, and a core table is
refused by declaration. Another *tenant's* database is not reachable at all: the app opens
`tenants/<key>/site.db` from the invoke's tenant, and the runner stamps `tenant` from its
`binding` — a plugin's own frames cannot name one (`server.mjs` `forwardHost`).

### 4.6 Install a package whose digest does not match its test report

Package root `ac1fd23e…`; report written for it; one comment appended to `index.mjs`; install:

```
REFUSAL: PLUGIN_REFUSED: SKW_E_PL_TESTS_STALE: the test report is for a different package root —
the bytes changed after the test run
EXIT=1
```

**Held.** Nothing was written (no row, no `data/plugins/attack`); restoring the byte made the root
identical (`862d1339…`) and the install succeed.

### 4.7 Install without a signature

```
plugin: installed id=attack version=0.0.1 root=ac1fd23e… enabled=yes package=…/data/plugins/attack
row: publisher="unsigned" signature_state="unsigned" enabled=1 runner_image_digest="dev"
```

`skwctl plugin install` exposes **no** `--signature`, `--publisher-key` or key input; the library's
`first_party`/`imported` paths are unreachable from the CLI. For a third-party plugin that means:

- there is **no publisher identity and no key fingerprint** — the operator's act of running the
  command against a directory is the entire trust decision;
- revocation is by **package root hash only** (`cms_plugin_revoked`); a publisher cannot be
  distrusted, only one build at a time;
- the "test report" is an **unsigned JSON file the installer supplies**, and the runner digest
  defaults to the literal `dev` when `SKW_RUNNER_IMAGE_DIGEST` is unset. "Tested" is
  self-attestation; it proves only that the bytes did not change between the report and the
  install;
- §8.5's install screen — publisher id and fingerprint, every capability in plain words, every
  table and its export class, first-party or not, the report's timestamp and digest — **does not
  exist**. The CLI prints id/version/root/enabled/package and nothing else. The trust decision the
  spec says the screen *is* cannot be made from this output.

### 4.8 Extra finding: a plugin that exceeds 2 s never comes back

The `net` probe exceeded the 2 s op budget; the runner `SIGKILL`ed the child. No code restarts it:

```
{"id":8,"ok":false,...,"message":"plugin attack is not ready"}
… 5 s later …
{"id":9,"ok":false,...,"message":"plugin attack is not ready"}
runner: plugin attack exited (SIGKILL)
```

**BROKEN.** One slow op permanently disables that package until the *container* restarts.
§8.6's "crash / hang → 503 on that endpoint only" is true for the first request and false forever
after.

---

## 5. Install from scratch, measured

I cut a real CMS bundle from the S4b demo data and installed it into an empty directory with
`--no-compose`, exactly as a customer would (no fixture shortcuts, no test helper):

```
node app/cli/export.ts --target cms --tenant acme --out scratch/s4-qa/bundle \
  --data-dir scratch/s4b/demo/data --origin https://acme.test --now 2026-10-21T00:00:00.000Z
# export: files=20 bytes=408391, tree_sha256 7b203d25…

SKW_ENV_FILE=…/scratch/s4-qa/cold.env ./scratch/s4-qa/bundle/install.sh \
  --bundle …/scratch/s4-qa/bundle --target …/scratch/s4-qa/cold/data \
  --runtime …/skunkworks --no-compose --verify-login
```

**First install:** exit 0, **real 1.25 s**. `bundle_verify: 19 file(s) verified`; control v4;
1 tenant seeded; tenant db installed; enrolment 0600; bootstrap; then:

```
install_check: signed in as owner@acme.test, GET /admin 200 (text/html)
install_check: GET / 200 543 B "Acme — the best widgets" host=acme.test
```

**Second install:** exit 0, **real 0.52 s**. Schema/seed/tenant/env all "left alone", bootstrap
exit 3 (benign), same page 200, **no second tenant**.

**Split:** machine **1.25 s** (first) / **0.52 s** (second); human **not measured** — a person must
scan the TOTP QR, which I cannot do — the spec's allowance is **20 s**. So **21.25 s of 300 s**,
and the perf gate's own run says `1.3 s + 20 s = 21.3 s of 300 s`. This is host-side only: no image
pull, no bundle transfer, no TLS, and `--no-compose`, so **the composed install is not measured**.

**Third step, a plugin through the operator surface** (`skwctl`, unsigned package):

```
SKW_DATA_DIR=…/cold/data node dist/app/cli/skwctl.js plugin install …/pkg/attack \
  --tenant acme --test-report …/pkg/report.json --enable
plugin: installed id=attack version=0.0.1 root=ac1fd23e… enabled=yes
plugin: the runner scans …/data/plugins at start; restart the runner service to load attack
```

Row created, `p_attack_note` and its registry row created, package copied (`index.mjs` 3386 B,
0644), `signature_state=unsigned`, `runner_image_digest=dev`. The install is *not* live until the
runner restarts, and the app's socket is not bound at all in a composed stack (`install_check`
printed `plugin.sock: not bound … plugin calls will refuse PL_UNAVAILABLE`).

**Side effect:** `install.sh` writes `certs/default.crt|key` into the **bundle** directory, *after*
`bundle_verify` hashed it. The verify still passes (it ignores extra files), but the verified
artefact has grown two files, and a read-only/root-owned bundle would fail here.

---

## 6. Export determinism, hashed independently

Three targets, two exports at `2026-10-21T00:00:00.000Z`, one at `01:00:00.000Z`. I hashed each tree
myself: sha256 over `relpath\0kind\0sha256-or-link-target\n`, every file, directory and symlink,
sorted — deliberately *not* the product's `hashTree()`.

| target | export A | export B (same clock) | +1 h | paths |
|---|---|---|---|---|
| static | `cd9d3f00ec4400d29df66de5f3ab8ae840865f750239abea3bec4fed7d59d25a` | **identical** | `47f65bd1053250935af516d5bd52b646181be6ed7377b859c6299dd20fa2c385` | 16 |
| astro | `5bcc76ebbb80daac0b3850341a7f35a6a84e74344870e5040c4aa7d919571b68` | **identical** | `3d250386bf40d65c20cf7402ad69006830127e140493ac3116068723d2e7bcd8` | 26 |
| cms | `a75d8ec86a4ff0e0ea077a108ba2ecafe518530726bc914ae89135f22e1ac556` | **identical** | `e4aa5632db3c414213ebb3e19038d13a1f775ae984ed6754817de34704146cf1` | 33 |

`diff -rq` at +1 h:

```
static: EXPORT-NOTES.md
astro:  EXPORT-NOTES.md
cms:    BUNDLE.json, EXPORT-NOTES.md
```

The only bytes that differ are `exported_at`; in `cms/BUNDLE.json` also `created_at`,
`export_now`, and the manifest's own sha256 of `EXPORT-NOTES.md` — the declared timestamp's file,
so its hash must move. No undeclared file or byte moved. Every file and directory in `static-a`
carries mtime `1792540800` (`2026-10-21T00:00:00Z`).

---

## 7. The seven items the repair run left open

These are S4d §6's seven. They are not the whole open list: the larger item from S4c §7 and
`STATUS.md` — **nothing in the product invokes a plugin** — is defect 2 in §8 and is a blocker on
its own. The seven are judged as the repair run framed them.

| # | item | what it is | my call |
|---|---|---|---|
| 1 | runner reload is manual; no status | install prints "restart the runner"; nothing compares the row with the runner's registry. With §4.8 (no respawn), a crash is permanent too | **Major.** Not a §16 row, but "install → enable → it works" needs it. It becomes a blocker when combined with the no-respawn defect |
| 2 | no `plugin uninstall` | §8.2's only downgrade path is uninstall-then-install; install refuses a different root under the same id; no uninstall exists | **Blocker (spec).** A bad plugin cannot be removed or upgraded through any operator surface — only by hand-editing `cms_plugin_installed` and deleting a root-owned directory. §8.6 requires the row |
| 3 | signature flags not exposed | the library supports `first_party`/`imported`; the CLI can only install unsigned | **Major (spec §8.5).** Unsigned is a legal state, so not a blocker by itself. The missing **install screen** (publisher/fingerprint/capabilities/tables/report) is the real gap: the trust decision §8.5 defines cannot be made |
| 4 | no TLS gate | every e2e harness strips `ssl_*`; nothing starts nginx against the real certs | **Blocker.** It hid a real cold-install failure: the bundle's `10-app.conf` names `/etc/nginx/certs/acme.test.crt`, the seed says `issued`, and `install.sh` writes only `default.crt`. `nginx -t` exits `[emerg] cannot load certificate … No such file or directory` |
| 5 | refusals are not audited | successful install/enable/disable write `cms_audit`; a refused enable writes stderr only | **Cosmetic-to-Minor.** Observability, not a control: the refusal still writes nothing |
| 6 | one tenant per command | no `--tenant all` | **Cosmetic.** A shell loop; the spec does not promise a fleet verb |
| 7 | copied package ownership/mode unasserted | `cpSync` inherits the invoking account; compose mounts `/srv/plugins:ro` | **Minor.** Correct only if the CLI runs as root; if it does not, the app (uid 10001/65534) may not read the package, and a world-writable package is tamperable by the tenant. Assert 0755/root or refuse |

---

## 8. Defects, in severity order

1. **Blocker — a cold install produces an nginx that cannot start.** The exported
   `control.seed.json` and `nginx/conf.d/10-app.conf` say `acme.test` is `issued`; the bundle ships
   no `certs/acme.test.crt`; `install.sh` writes only `certs/default.crt`. Proof, against the real
   generated config and the real `certs/` directory:
   ```
   [emerg] cannot load certificate "/etc/nginx/certs/acme.test.crt":
     BIO_new_file() failed … No such file or directory
   nginx: configuration file /etc/nginx/nginx.conf test failed
   ```
   `nginx` depends only on `app`; acme-companion cannot issue because nginx is not up. First
   `docker compose up` on a fresh bundle is a dead site. The exporter copies `cert_state` from the
   tenant (`app/export/cms.ts`), so this is every bundle cut from a tenant that had TLS.
2. **Blocker — no product code calls a plugin.** `plugins.invoke` has **no caller** under `app/`
   (`grep -rn 'plugins.invoke' app --include=*.ts` finds only the class itself; `main.ts` calls
   `plugins.connect()` and `plugins.list()` and nothing else). The runner answers RPC in
   `test/runner-contain.test.ts` and the host client answers in `test/plugin-host.test.ts`, but a
   page, form or route never asks a package to do anything. "Install → enable → render" is
   unusable in a composed stack; this is the S4c open item that S4d did not close, and it is the
   first thing a plugin customer hits.
3. **Blocker — the plugin runner has no memory cap.** `Memory=0`, `memory.max=max` inside a
   1.54 GB VM; a package held 256 MB (container 321 MiB, 21.85%) and can hold until the VM OOMs.
   §8.4's "it cannot starve the host" is false. One hostile plugin takes the site down.
4. **Blocker — §16 S4 row 2 does not exist.** `savePage()` accepts a `list` with two
   `[data-repeat]` children and persists both as row templates; no validator test. The spec's
   refusal is absent, so the slice's own acceptance table cannot be signed.
5. **Blocker (spec) — no uninstall/upgrade path.** §8.6's table has an uninstall row; §8.2 says
   uninstall-then-install is the only downgrade; the CLI has neither. A bad plugin is permanent.
6. **Major — a plugin killed on the 2 s op budget is never restarted.** `plugin.list` reports
   `ready:false` forever; every later call is `PL_UNAVAILABLE` until the container restarts.
   Contradicts §8.6's crash/hang row.
7. **Major — the runner does not enforce capabilities on host calls.** `forwardHost()` forwards
   `skw.call('mail.send')` from a package that never declared it; the app's `host.ts` is the only
   check. P4 proves that check works today; defence in depth is one line in one file.
8. **Major — §8.5's install screen is absent.** The CLI prints no publisher, fingerprint,
   capability list, table list, first-party flag, report timestamp or digest; unsigned is not even
   labelled. The operator cannot make the trust decision the spec defines. The test report is an
   unsigned file the installer supplies, with `runner_image_digest` defaulting to `dev`.
9. **Minor — `install.sh` writes into the verified bundle** (`certs/default.*`), after
   `bundle_verify`; a read-only bundle fails at the cert step, and the verified tree is no longer
   the installed tree.
10. **Cosmetic — refused installs/enables are not audited; one tenant per command; package
    ownership/mode unasserted.**

Verdict: **NO-GO.** Defects 1–5 are blockers. The 534-test suite is green and the negative
controls show it has teeth on the paths it measures; it does not measure the first `compose up`,
the certificate a bundle names, the memory a package can take, or a page actually calling one.

---

## 9. The one thing most likely to break in a customer's first week

**The first `docker compose up` after install: nginx exits at config parse because the bundle marks
its tenant host `issued` and no certificate for that host exists.** It is not a rare path — every
bundle exported from a tenant that ever had TLS carries `cert_state: "issued"`, and `install.sh`
creates only the self-signed `default` pair. The install says "done", the operator runs compose,
and the site is down with `cannot load certificate "/etc/nginx/certs/<host>.crt"`. The suite cannot
see it because every nginx gate strips `ssl_*` by design (S4d §2) and every install gate passes
`--no-compose`.

---

## 10. Reproducing

```
# the gate, three times
make test                                  # 534/534, exit 0
make verify-dist                           # 6/6, exit 0
make test-perf                             # refused at load 10.72/8 cpus, exit 2

# §16 rows
node scripts/run-node-tests.mjs --timeout=40000 test/roundtrip.test.ts test/editor-save.test.ts \
  test/csp.test.ts test/export-projection.test.ts test/export-determinism.test.ts test/bundle-verify.test.ts
node scripts/run-node-tests.mjs --timeout=60000 test/export-targets.test.ts test/plugin-host.test.ts test/install.test.ts
node scratch/s4-qa/two-repeat.mts           # row 2: ACCEPTED

# cold install
SKW_ENV_FILE=$PWD/scratch/s4-qa/cold.env ./scratch/s4-qa/bundle/install.sh \
  --bundle $PWD/scratch/s4-qa/bundle --target $PWD/scratch/s4-qa/cold/data \
  --runtime $PWD --no-compose --verify-login

# the nginx proof
SKW_ADMIN_ORIGIN=https://admin.skw.test node dist/tools/nginx_gen.js \
  --data-dir scratch/s4-qa/cold/data --out scratch/s4-qa/nginx/10-app.conf
docker run --rm --add-host app:127.0.0.1 \
  -v "$PWD/scratch/s4-qa/bundle/nginx/conf.d:/etc/nginx/conf.d:ro" \
  -v "$PWD/scratch/s4-qa/bundle/snippets:/etc/nginx/snippets:ro" \
  -v "$PWD/scratch/s4-qa/bundle/certs:/etc/nginx/certs:ro" nginx:1.31-alpine nginx -t

# containment
docker build -t skw-runner:qa runner
# run with --network none --read-only --cap-drop ALL --pids-limit 64, mount test/fixtures/plugins
# + scratch/s4-qa/plugins/attack; then: docker exec qa-attack node /srv/client.mjs '<json>'
```

Artifacts: `scratch/s4-qa/` (logs, JSON probes, the bundle, the cold install, the three export
trees, mutation backups). No product file is modified; `git status` shows only the builder's
untracked `docs/build/STATUS.md` and this scratch directory.

---
---

# S4 QA — Round 2

**Verdict: NO-GO**, narrowly. **All five round-1 blockers are genuinely closed** — I reproduced each
one, and every gate I broke went red and the file came back byte-identical. The trust surface is
real and resisted **7 of 7** attacks, including a genuine fingerprint-prefix collision. The 566-test
gate is green three times, `verify-dist` is 6/6, and the leak audit is clean.

The two things that stop a GO are both in the **newest** work, and both are claims of closure that
do not survive being used:

1. **§8.5's revocation clause has no implementation of the action.** The spec names
   `data/trust/revoked.json`; nothing reads it, nothing writes it, and `skwctl` has no `revoke`
   verb. The table the code does read (`cms_plugin_revoked`) has exactly one writer in the tree —
   `test/plugin-host.test.ts:217`, a gate. An operator who revokes a package root, exactly as §8.5
   instructs, gets a silent no-op and the revoked build **installs**.
2. **E-29/E-30 are drafted, not applied.** `docs/sds/02-errata.md` §13 is written and good; the
   builder items that amend `docs/sds/SDS.md` have not run — the file has not changed since
   `18bb785` — so the specification of record still states the rule that produced round 1's dead
   first boot (§12.5/:2220/:2222/:2256), still says a package "cannot starve the host"
   (§8.4/:1443, §13.3/:2354), carries no `Amended by 02-errata.md E-29/E-30` pointer, and
   `POINTERS` is still `range(1, 24)` (`scripts/model/check_frozen.py:206`). The final report's
   table cites `make verify-frozen` as the gate for this, and `verify-frozen` does not check it.

**Tree:** `ccedc82`. `git status --short` after every mutation and restore: `?? scratch/s4-qa2/` —
**no tracked file modified**, nothing committed.
**Date:** 2026-10-21, 06:48–07:10 AEDT. **Box:** macOS 15.7.4, 8 CPUs, Docker 29.7.2 (1.54 GB VM),
node 22.23.1. Load average 11–36 throughout; every timing below is labelled with that.

---

## R2-1. The gate, three times — plus `verify-dist` alone and the perf guard

`/usr/bin/time -p make test`, full output captured. Logs `scratch/s4-qa2/make-test-{1,2,3}.log`;
exit codes in `scratch/s4-qa2/exits.txt`. Counts are the TAP summary, not a grep of `ok` lines.

| run | tests | pass | fail | skipped | exit | wall |
|---|---|---|---|---|---|---|
| 1 | 566 | 566 | 0 | 0 | **0** | 218.55 s |
| 2 | 566 | 566 | 0 | 0 | **0** | 183.15 s |
| 3 | 566 | 566 | 0 | 0 | **0** | 203.51 s |

`make verify-dist` alone: **6/6, exit 0, 6.06 s** (`scratch/s4-qa2/verify-dist.log`), D1–D6 each
printing what it executed (boot, page, download, migrate, skwctl, nginx_gen).

`make test-perf`: **REFUSED, exit 2** (`scratch/s4-qa2/test-perf.log`):

```
make test-perf: PERFORMANCE GATE — wall-clock assertions, not correctness
  box: 8 cpus, 1-min load average 11.73
  REFUSED: load 11.73 on 8 cpus — this box is oversubscribed …
make: *** [test-perf] Error 2
```

So the perf gate **did not run** and none of its numbers can be quoted as a pass — same as round 1,
and the builder's own §10.5 lists it as still needing an idle box. `SKW_ALLOW_SKIP` and
`SKW_SKIP_DOCKER` were never set; a skip is a failure in this suite and none was reported.

**Count claim checked:** 566, three times, matching the final report. (§10.6's artifact note calls
`scratch/s4f/make-test.log` "the 565 run" — a stale filename, not a claim about this tree.)

---

## R2-2. The five round-1 blockers — each reproduced, not read

| # | round-1 blocker | how I verified it this round | result |
|---|---|---|---|
| 1 | a cold install's nginx cannot start; `cert_state` claims `issued` | cut a CMS bundle from a tenant whose control plane said `issued`; installed into an empty dir; `docker compose up` four services; HTTPS GET through nginx; `openssl s_client` for the peer; read `cert_state` from the installed control.db | **CLOSED** |
| 2 | no product code calls a plugin | `test/plugin-composed.test.ts` alone: 4/4, 7.34 s; C2 is a real `GET /_plugin/notes/list` answered 200 with the row the host read from `site.db` inside the container | **CLOSED** |
| 3 | the runner has no memory cap | my own container, shipped flags, 4 GiB hoard | **CLOSED** |
| 4 | §16 S4 row 2: two `[data-repeat]` children accepted | production `savePage()` on a two-child document, and on a one-child control | **CLOSED** |
| 5 | no uninstall / no clean tenant | data-bearing uninstall through `skwctl`, then a full tenant census | **CLOSED** |

### 2.1 First boot over HTTPS, honest `cert_state` — `scratch/s4-qa2/transcript.log`

Bundle: seed hosts both `cert_state: none`; **0** `.crt`/`.key` in the bundle; every tenant block
`listen 80; listen 443 ssl;` naming `<host>.crt`. Install minted `acme.test` + `default` pairs into
`<data>/certs` (keys 0600). `compose up`: `acme`, `app`, `nginx`, `plugin-runner` all Up. Then:

```
HTTP/1.1 200 OK
Server: nginx/1.31.7
<!DOCTYPE html> … <h1>acme pricing</h1>
--- certificate ---
subject= /CN=acme.test
issuer= /CN=acme.test
SAN: DNS:acme.test,DNS:www.acme.test
--- cert_state in the installed control plane ---
{ host: 'acme.test', cert_state: 'none' }
--- acme log ---
acme: pass failed: connect ECONNREFUSED 127.0.0.1:9
```

Both facts true at once: a certificate answers on 443, and the control plane does **not** claim a CA
issued it. `nginx -t` against the generated conf plus the minted certs: *syntax is ok / test is
successful*. Independently, the suite's T1–T5 passed in all three runs, including T5 against Pebble.

**One defect this surfaced, minor and uncovered** — see R2-6.6: the *generated conf's comment* still
says `# certificate: issued` on a bundle whose seed says `none`.

### 2.2 A plugin through the composed stack

`test/plugin-composed.test.ts` alone: `4/4 pass`, 7.34 s. C1 asserts the two-container shape and the
bound socket; C2 is an HTTP request to the app container answered `200 application/json` with
`{"rows":[{"body":"written-before-the-request"}],"count":1}` — the row read by the host from the
tenant database inside the invoke the HTTP request started; C3 is a POST that writes through the
host and is then found in `site.db`; C4 is the 404 after uninstall.

### 2.3 The runner memory bound, by hand — `scratch/s4-qa2/memhoard-probe.sh`

Own container, flags copied from `docker-compose.yml`, `skw-runner` built from `runner/`:

```
Memory=402653184 MemorySwap=402653184 PidsLimit=64
memory.max=402653184
idle: 20.68MiB / 384MiB
4 GiB request:
{"ok":false,"plugin":"memhoard","code":"SKW_E_PL_OOM",
 "message":"plugin memhoard was killed at the runner's 384 MiB cgroup while running hold"}
memory.peak=402653184
Running=true OOMKilled=true ExitCode=0      # the container is alive; the child that died was restarted
250 ms later: {"ok":true,"result":{"requested_mb":8,"held_mb":8,"rss_mb":48}}
JS-object hoard: {"ok":false,"code":"SKW_E_PL_OOM", … "while running holdObjects"}
```

The ceiling is real, `memswap_limit` equals it, the host is out of the blast radius, and the package
answers on the next request. §8.4's sentence is now true *by the cgroup*, not by assertion.
*(Observability nuance, not a defect: `OOMKilled=true` is set on the container even though
`Running=true` — a dashboard reading that flag will report a dead runner that is not dead.)*

### 2.4 The repeat validator, and its teeth

`node scratch/s4-qa2/two-repeat.mts` → `REFUSED a list has 2 [data-repeat] children; exactly one
repeat template is allowed`; the one-child control → `ACCEPTED` with `items.list` position 0.

Mutation `app/editor/model.ts:183` `if (rows.length > 1)` → `if (rows.length > 1 && false)`:
`test/editor-save.test.ts` **exit 1, 11 pass / 1 fail**, `not ok 7 - S6b …`. Restored:
`321588b073cf6a00bbf54e6f52241fba9cf747ad8d0c6f66fc5d5887d7fa8294` before = after, gate back to
**12/12**. (Hash matches the builder's own §6 row 5.)

### 2.5 Uninstall leaves a clean tenant

Signed install, then 2 rows and 2 settings written into `p_notes_note`/`cms_plugin_setting` (one of
them `secret: true`), then `skwctl plugin uninstall notes`:

```
plugin: uninstalled id=notes version=1.0.0 root=cf4e41d1… tables=p_notes_note(2) settings=2
archive … notes-1.0.0-….json (0600; table-scoped, restore by hand)
```

Archive: `format skw-plugin-archive/1`, rows `["first-row","second-row"]` in order, settings
`[{"key":"api_token","secret":true,"value_json":null},{"key":"signature",…,"value_json":"\"sig-value\""}]`,
and the literal secret value **absent from the file** (`contains('super-secret-token') → false`).
Tenant census after: `installed 0, registry 0, migration 0, settings 0, p_* tables 0, asset triggers
0`; `data/plugins/` empty; archive 0600.

---

## R2-3. The trust surface, attacked seven ways — `scratch/s4-qa2/trust-attacks.{mts,log}`

Every attack is driven through the shipped `skwctl` and the shipped `tools/plugin_sign.ts`; nothing
re-implements the verifier. Each row snapshots the tenant (installed row, plugin tables, audit count,
`publishers.json` sha256, plugin tree hash) before and after; *state* = that whole snapshot is
byte-identical. Full text in `scratch/s4-qa2/trust/attacks.json`.

| # | attack | exact refusal | exit | state |
|---|---|---|---|---|
| i | edit a file after signing | `SKW_E_PL_SIGNATURE: the package was edited after it was signed: index.mjs` | 1 | unchanged |
| ii | edit `plugin.json` | `… edited after it was signed: plugin.json` | 1 | unchanged |
| ii-b | *widen* the grant in `plugin.json` (add `store.delete`) | `… edited after it was signed: plugin.json` | 1 | unchanged |
| iii | **add** a file | `… edited after it was signed: extra.mjs was added` | 1 | unchanged |
| iv-a | signature swapped between two builds of one `id@version` | `… edited after it was signed: plugin.json` (the differing file named) | 1 | unchanged |
| iv-b | signature swapped between two plugin ids | `the signature is for echo@1.0.0 but the package is notes@1.0.0` | 1 | unchanged |
| v | `--allow-unsigned` | without the flag: `notes is not signed by any key this install trusts; pass --allow-unsigned to install it anyway (the install is audited as unsigned)`. With it: banner printed twice, row `publisher=unsigned, fingerprint=null, signature_state=unsigned`, audit `"allow_unsigned":true` | 1 / 0 | changed **by design**, audited |
| vi | replace a trusted publisher key silently | `acme-labs is already imported as spki-sha256:b5f39950…6541; this key is spki-sha256:e92f6a03…babf — re-run with --replace to revoke the old key`; store sha `8e7ea4b9c5b95c06` unchanged. `--replace` then succeeds (positive control) | 1 | trust file unchanged |
| vii | a key colliding in **fingerprint prefix only** | trusted `b5f3…`; generated a real 16-bit collision at attempt 100,087 in 20.4 s — `b5f3f806…5425`; install: `the package was signed by spki-sha256:b5f3f806… but acme-labs is trusted as spki-sha256:b5f39950…`. Forged variant (rewrite `key_id` to the *trusted* fingerprint verbatim): `the signature does not verify against spki-sha256:b5f39950…` | 1 | unchanged |

**7/7 refused correctly.** The verifier's order is right — shape, then key identity, then the
cryptographic statement, then the file list, then the root — so an edit is reported as an edit and not
as a bad signature, and the two ways to lie about *which key signed* (a colliding prefix, a stolen
`key_id`) both fail: the first at the trust-store comparison, the second at the signature check.

**But the surface records a publisher it never verified.** An **unsigned** package that merely writes
`"publisher": {"id": "acme-labs"}` in `plugin.json` and is installed with `--allow-unsigned` produces:

```
screen:   publisher        acme-labs
          key fingerprint  (none — unsigned)
row:      notes|acme-labs|NULL|unsigned|1
audit:    {"publisher":"acme-labs","publisher_key_fingerprint":null,"signature_state":"unsigned",
           "allow_unsigned":true}
```

The durable record — the row an auditor reads after an incident, and `cms_audit` — attributes the
package to a trusted publisher id with no fingerprint. `signature_state=unsigned` is the only tell,
and a `WHERE publisher='acme-labs'` query does not filter on it. The screen is honest ("(none —
unsigned)" plus the banner); the row is not. See R2-6.4.

---

## R2-4. Two capability layers — disabled one at a time

`scratch/s4-qa2/capability-mutations.sh`, `test/plugin-capability.test.ts` after each edit, restore by
hash. Baseline 5/5 green.

| mutation | C1 (runner) | C1b | C1c (intersection) | C2 (host) | C2b (no grant) |
|---|---|---|---|---|---|
| **M1** `runner/server.mjs:420` `if (!binding.granted.has(op))` → `if (false && …)` | **not ok** | ok | **not ok** | ok | ok |
| **M2** `app/plugins/host.ts:168` `if (!row.manifest.capabilities.includes(op))` → `if (false && …)` | ok | ok | ok | **not ok** | ok |
| restored | ok | ok | ok | ok | **5/5** |

`server.mjs` `547553c57645c4b32ea5da805983bdffe47fbef2adf92588f02f10113fc59186` before = after;
`host.ts` `712c213061a32d87482f4f339c683205b8ea2d239ac5833bff643f0bbee41ae3` before = after. The two
layers fail **only** in their own column — neither can pass by way of the other.

**With the host check off, `store.delete` succeeds.** The failure message is the evidence:

```
not ok 4 - C2 — the host refuses an undeclared op even when the runner forwards it …
    {"type":"host.result","id":"h1","ok":true,"result":{"changes":1}}
```

one row deleted, and the gate's post-condition (the row is still there) is what makes it visible.

**Are they genuinely independent?** *As controls, yes; as trust roots, no.* They run in different
processes and share no code path: the runner's set is `binding.granted` = the app's `granted`
**intersected with `plugin.json` on disk** (`server.mjs:529`); the host's is
`row.manifest.capabilities` read from `cms_plugin_installed.manifest_json` **in the tenant database**
(`host.ts:168`). Two different artefacts can disagree (a stale runner holds the old manifest; the DB
row holds the new one), and either layer alone refuses. But both read the **same authored object** —
the package's manifest — one copy on disk, one in the row. A defect in manifest parsing, or write
access to that row, widens both at once. Stated exactly: the layers are independent *implementations*
of the same policy, not independent *sources* of it. That is the right shape for defence in depth
(the runner trusts its own copy of the package, not the app's word), and it should not be described
as two independent authorities.

---

## R2-5. Regression sweep on what round 1 found sound

| property | round 1 | round 2 | evidence |
|---|---|---|---|
| `make test` | 534/534 ×4 | **566/566 ×3**, exit 0 | R2-1 |
| `make verify-dist` | 6/6, 5.66 s | **6/6, 6.06 s** | R2-1 |
| leak audit | clean | **clean** (`before: 0/0`, negative control red, `after: 0/0`) | run logs |
| export determinism, same clock | identical | **identical** — static `1d276222…`, astro `28440950…`, cms `5cccfeb9…` for both exports | `scratch/s4-qa2/det` |
| at +1 h | only `exported_at` moves | **only `EXPORT-NOTES.md`** (static, astro) and `BUNDLE.json` + `EXPORT-NOTES.md` (cms) | `diff -rq` |
| install, machine half | 1.25 s / 0.52 s | **1.15 s / 0.60 s**; page served 200 543 B; one tenant after two installs | `install-1.log`, `install-2.log` |
| install, human half | 20 s (allowance) | **20 s allowance, not measured** — a person must scan a TOTP QR | — |
| total against the 5-minute promise | 21.25 s | **21.15 s of 300 s** (host-side, `--no-compose`, no image pull, no TLS) | — |
| CSP on the wire | one hash in three targets | live header **194 bytes, identical** to `snippets/skunk-csp.conf`; cms bundle ships the same file `6dd0ec9d…` | `csp-wire.txt` |
| bundle unchanged by install (round-1 defect 9) | certs written into the bundle | **certs go to `<data>/certs`**; the bundle gains only an empty `run/` directory | tree hash before/after |

The determinism hashes are **not** the product's `hashTree()`: `scratch/s4-qa2/treehash.py` walks
every file, directory and symlink, sorts `kind\0relpath\0sha256`, and hashes that.

Install timing caveat, same as round 1 and still material: this box was at load 11–36, and the
composed install (image pull, TLS, bundle transfer) is **NOT COVERED** — see R2-7.

---

## R2-6. New defects, in severity order

**1. Major (specification, security) — §8.5's revocation control has no implementation of the
action.** §8.5: *"revocation is an operator action against a package root in
`data/trust/revoked.json`, which is local to the install"*, and install refuses *"a revoked root
(`SKW_E_PL_REVOKED`)"*. The same read is drawn in `docs/sds/diagrams/plugin-install.puml:22`
("read revoked.json"). Measured (`scratch/s4-qa2/revoke-probe.mts`):

```
revoked_file_written: …/trust/revoked.json          (0600, the root, the plugin id, a reason)
install of that exact root:  status 0  "plugin: installed id=notes … root=cf4e41d1… enabled=yes"
skwctl plugin revoke notes --root …:  status 1  REFUSAL: USAGE: usage: skwctl plugin (install … |
                                      trust … | enable | disable | uninstall | list)
hand-insert into cms_plugin_revoked:  status 1  SKW_E_PL_REVOKED: package root cf4e41d1… is revoked
```

So the **file has no reader and no writer**, the **verb does not exist**, and the only way to revoke
is to hand-edit SQLite. `grep -rn "INTO cms_plugin_revoked" app/ tools/ scripts/ test/` finds exactly
one writer: `test/plugin-host.test.ts:217`. A security control that accepts the documented gesture
and does nothing is worse than an absent one: the operator believes the build is blocked and it is
not. §10.5 names the file as "no writer" and grades it *minor*, framing it as a duplicate source of
truth — the file is not a second source of truth, it is not a source at all.

**2. Major (specification, evidence) — E-29/E-30 are drafted, not applied, and the closure claim
cites a gate that does not check them.** `docs/sds/02-errata.md` §13 exists and is good. Its own
builder items 1–4 say *paste the drop-ins into `docs/sds/SDS.md`*. `git log 18bb785..HEAD --
docs/sds/SDS.md` is **empty**; the retired clauses are still there:

```
1443  … It cannot starve the host and it cannot affect a page (§13.3).      # E-30, unamended
2354  … it cannot starve the host, and it cannot affect a page …            # E-30, unamended
2220  is on every block because §12.5 promises a host serves on 80 while …   # E-29, unamended
2222  `domain.cert_state = 'issued'` — a block that listens on 443 … fails
2256  reports `certificate: pending` and serves on 80.                       # E-29, unamended
```

No `> Amended by 02-errata.md E-29/E-30.` pointer (the established convention — E-20…E-23 all have
one), and `POINTERS = tuple(f"E-{n}" for n in range(1, 24))` at `scripts/model/check_frozen.py:206`,
i.e. still `23/23`. The errata's item 5 is acknowledged as owed; items 1–4 are not. `verify-frozen`
asserts that the SDS quotes the *frozen register* — it cannot see an unapplied errata, so
§10's "**closed** … `make verify-frozen` green" is not evidence for what it claims. This matters
in the direction the errata itself warns about (line 2923): *"an errata that only re-worded the
sentence would leave the next Builder free to 'fix' the code back to the text"* — here even the
sentence was not re-worded.

Also in that section, a citation error: builder item 3 says §16's S4 row 12 still says *"serves on
80 while pending"*. §16's S4 row 12 actually reads *"install on a clean host: ≤ 5 min with images
present, `certificate: pending` allowed"* — it never mentions 80 or 443, so no change is owed there;
the phrase the errata wants to retire lives in §12.5/:2256.

**3. Major (operator surface) — the only upgrade path §8.2 defines fails with `INTERNAL:`.**
`SKW_E_PL_SCHEMA` is not in `schema/error-codes.json`'s `http` map. `AppError`'s constructor *throws*
when the code has no mapping (`app/errors.ts:189-191`), so the intended refusal never survives:

```
REFUSAL: INTERNAL: no HTTP mapping for SKW_E_PL_SCHEMA (schema/error-codes.json)
exit 1
```

Reached by installing a different root under an installed id — which is exactly what
`installPlugin()` says to do after uninstalling, and the message that should read *"notes is
installed at root X; uninstall it before installing Y"* is lost — and by any
`requires.site_db_min/max` refusal. `app/plugins/ops.ts:39-45` documents the correct pattern in a
comment (*"an AppError here would demand an HTTP mapping the taxonomy does not have"*) and uses a
plain `Error`; `install.ts` did not follow it for `SKW_E_PL_SCHEMA`. No gate covers the downgrade
refusal (`grep 'uninstall it before installing' test/` → none), and `test/error-codes.test.ts` only
mirrors JSON↔table, not code references. `SKW_E_PL_DOWNGRADE`, which §8.2 names, exists **nowhere**
in `app/`, `schema/` or `test/`.

**4. Major (audit integrity) — an unsigned package can name a publisher that never signed it.**
Proven in R2-3: row `publisher=acme-labs`, `publisher_key_fingerprint=NULL`,
`signature_state=unsigned`. `VerifiedPackage.publisher` takes the manifest's self-declared id when
there is no signature (`trust.ts:257`). It should stay `unsigned`, with the self-claim in a separate,
clearly-labelled field (`claimed_publisher`), so the durable record cannot attribute an unsigned
package to a trusted id.

**5. Minor — re-installing identical bytes with `--allow-unsigned` silently downgrades the recorded
provenance.** Audit rows from one session: first install
`{"publisher":"acme-labs","signature_state":"imported","allow_unsigned":false}`, then the same root
`cf4e41d1…` installed again with `--allow-unsigned` →
`{"publisher":"unsigned","signature_state":"unsigned","allow_unsigned":true}`. The bytes are the
same, so nothing was substituted; what is lost is the strongest evidence *about* those bytes. The
audit chain still holds the earlier row, so this is recoverable by a careful reader.

**6. Minor — the exported nginx conf tells the operator the wrong certificate state.**
`app/export/cms.ts:361-363` feeds `generateAppConf` the *source tenant's* `cert_state`, while the
seed is forced to `none`. Result, on a bundle cut from a tenant that had TLS:

```
data/control.seed.json   → cert_state: "none"
nginx/conf.d/10-app.conf → # certificate: issued
```

E-29's whole point is that the state is a **comment** the operator reads *because* the listener no
longer depends on it; on a cold install the truth is "pending (self-signed until ACME)". The comment
is the one claim in the artefact that still travels from the source box — the same class of defect as
round 1's blocker 1, in the last place it was left. It is a comment only: `nginx -t` passes and the
site serves. One-line fix; no gate asserts it (`T1` checks the seed, not the comment).

**7. Minor (evidence) — the builder's end-to-end transcript no longer reproduces what §9 cites it
for.** `bash scratch/s4e-transcript.sh` exits 0 but its steps 7–10 now fail:

```
### 7. a plugin, through the product's public endpoint (D25)
REFUSAL: PLUGIN_REFUSED: SKW_E_PL_SIGNATURE: notes is not signed by any key …
GET /_plugin/notes/list  -> {"code":"SKW_E_RT_PAGE_NOT_FOUND"}      # never installed
### 10. runner memory … -> {"code":"SKW_E_PL_ROW","message":"plugin.invoke needs the granted
        capability set (the app owns the grant)"}                   # 28.8 MiB peak, not 384
```

The script predates S4f's signature requirement and the `granted` wire field, and `set -uo pipefail`
without `-e` means it exits 0 while printing refusals it never asserts. §9's
`bash scratch/s4e-transcript.sh  # the transcript quoted above` therefore does not reproduce §2.3 or
§3.3. The *gates* for those steps are sound (I ran them); the transcript is evidence that has rotted.

**8. Cosmetic — `install.sh` still writes one thing into the verified bundle: an empty `run/`
directory** (34 → 35 entries; `bundle_verify` passes because it ignores extra paths). It is the
socket mount point and is created next to the compose file, so this is understandable, but "the
verified artefact is the installed artefact" is still not quite true.

---

## R2-7. What is NOT COVERED

- **The composed install end-to-end as a customer does it** — image pull from a registry, bundle
  transfer, real DNS, a real CA. The registry digests do not exist on this box; the transcript and
  the gates use locally built images (`skw-app:s4d`, `skw-acme:s4e`, `skw-runner:s4e`). The first
  boot *is* proven over HTTPS (R2-2.1); the *acquisition* of the images is not.
- **A production-CA issuance.** Pebble, with validation not short-circuited, is proven (T5). That is
  stronger than §13.4's note claims, and still not Let's Encrypt.
- **`make test-perf`** — refused by its own load guard (R2-1). No wall-clock number in this report is
  a perf-gate pass; the install timings are single measurements on a box at load 11–36.
- **The human half of the install** (TOTP enrolment) — 20 s is the spec's allowance, not a
  measurement.
- **A 1 GiB bundle transfer**, browser behaviours, PII retention — unchanged from §13.4.

---

## R2-8. The five named limits in §10.5, judged

| # | limit as the builder states it | my judgement | why |
|---|---|---|---|
| 1 | per-tenant trust is not modelled (`publishers.json` is one file per install, "§8.5's own path") | **Acceptable** | §8.5 names that exact path, so it is conformant to the letter. With one operator account per install the "tenant owner" is the box operator; the screen says where the key came from. It becomes a cross-tenant trust bleed only when tenants are unrelated customers — a v2 decision, correctly named. Not a violation. |
| 2 | the image's first-party key is a placeholder with no retained private half, so first-party packages cannot be signed | **Spec violation** (fails closed) | §8.5: *"the image carries our public key and verifies first-party packages against it."* The image carries a key that can verify nothing, and no signer exists, so **every** vendor package must be installed with `--allow-unsigned` and is audited as unsigned. The control is not bypassed — it is unusable on its primary path, and the workaround trains operators to type the flag that exists to be rare. A release-pipeline step, but the shipped artefact does not meet the sentence. |
| 3 | `data/trust/revoked.json` is named by §8.5 and has no writer — "revocation is `cms_plugin_revoked` today" | **Spec violation, and the highest-severity item** | The file has no **reader** either, and the table has no operator writer (one test only). Revocation is not "the table today"; it is nothing an operator can do. The builder's framing (a duplicate source of truth) understates a control that silently no-ops. |
| 4 | a signature does not travel in an export; the bundle's root and `BUNDLE.json` are the integrity claim | **Acceptable** | §8.5 does not promise bundle provenance, and the two artefacts it does name are checked by `bundle_verify`. The distinction that matters — integrity of the bytes vs. who published them — is stated rather than implied. |
| 5 | the runner holds its package list from boot, so install/uninstall say "restart the runner service" | **Acceptable with real friction** | Not a spec violation: the CLI says it, and the app reconnects on demand. But it is the limit a customer meets **first** — install succeeds, the endpoint 404s, and the fix is the last line of output. A `reload` verb on the socket (the runner already owns the scan) would remove it. |

**Which would hurt a customer first:** #2 and #5, on day one — #2 because the vendor's own packages
need `--allow-unsigned`, #5 because "install → enable → it works" needs a restart the customer will
not read. **Which would hurt worst:** #3, on the day they need it — an incident where a bad build must
be blocked, and the revocation they perform does nothing.

---

## R2-9. Reproducing

```
make test                                            # 566/566/0/0, exit 0, ×3
make verify-dist                                     # 6/6, exit 0
make test-perf                                       # refused at load 11.73/8 cpus, exit 2

node scratch/s4-qa2/trust-attacks.mts                # the seven attacks
node scratch/s4-qa2/revoke-probe.mts                 # the revocation probe
bash scratch/s4-qa2/capability-mutations.sh          # M1/M2 + byte-identical restore
bash scratch/s4-qa2/memhoard-probe.sh                # the 4 GiB hoard against 384 MiB
node scratch/s4-qa2/two-repeat.mts                   # row 2, refused
bash scratch/s4e-transcript.sh                       # first boot (steps 7–10 are stale, R2-6.7)
node scratch/s4-qa2/treehash.py <dir>…               # independent tree hash
```

Artifacts: `scratch/s4-qa2/` — `make-test-{1,2,3}.log`, `verify-dist.log`, `test-perf.log`,
`trust-attacks.{mts,log}` and `trust/attacks.json`, `revoke-probe.mts`, `cap/`,
`memhoard-probe.sh`, `det/` (three targets × three exports), `bundle/`, `cold/`, `install-{1,2}.log`,
`transcript.log`, `csp-wire.txt`, `treehash.py`, and the mutation backups. No product file is
modified; `git status --short` is `?? scratch/s4-qa2/` only, and every mutated file's sha256 is
identical to its backup (R2-2.4, R2-4).

---

## R2-10. Verdict

**NO-GO**, on one security control and one unapplied amendment — not on the five blockers, all of
which are closed and were closed properly.

What is genuinely good, and should not be redone: the first boot serves HTTPS with a certificate
whose bytes exist and a `cert_state` that does not lie; a plugin answers through two containers and a
unix socket; the memory ceiling is a real cgroup at 384 MiB with no swap escape and a surviving
container; a two-child `list` is refused by name; uninstall archives the data, redacts the secret and
leaves a clean tenant; and the signature verifier refused all seven attacks, including a real
fingerprint-prefix collision and a forged `key_id`. The capability split is two real controls in two
processes.

**Highest-severity remaining item:** §8.5's revocation control is unimplemented as an operator
action — `data/trust/revoked.json` is neither read nor written, `skwctl` has no `revoke` verb, and
`cms_plugin_revoked` is written only by a gate, so a package root an operator believes they have
revoked still installs. Fix that (a reader for the file *or* a `revoke` verb that writes the table,
plus a gate that revokes through the operator surface and then asserts the refusal), apply E-29/E-30
to `docs/sds/SDS.md` with their pointer lines and the `POINTERS` range, and map `SKW_E_PL_SCHEMA` —
then this slice is a GO.
