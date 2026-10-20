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
