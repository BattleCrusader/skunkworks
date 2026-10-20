# S4 final — the five blockers, closed

**Verdict: the five NO-GO blockers are closed, each by a gate that was seen red on a real
mutation and restored by hash.** `make test` is green at **554 tests / 554 pass / 0 fail /
0 skipped, exit 0, 161.18 s** (S4 QA: 534). `verify-dist` 6/6 and the leak audit clean.

**Tree:** the five blockers plus the regressions they exposed. No commit was made, no gate was
weakened, `SKW_ALLOW_SKIP` was never set, and no test asserts a wall-clock value outside
`test/perf`. Every number below is from a run on this box (macOS 15.7.4, Docker 29.7.2,
1.54 GB VM, node 22.23.1). Where a step needed a registry pull that is unavailable here it is
said so and proved with locally built images.

| # | Blocker (S4 QA §8) | State | The gate that holds it |
|---|---|---|---|
| 1 | a cold install's nginx cannot start; `acme` exits 1 | **closed** | `test/first-boot-tls.test.ts` T1–T5 |
| 2 | no product code calls a plugin | **closed** | `test/plugin-host.test.ts` E1–E5, `test/plugin-composed.test.ts` C1–C4 |
| 3 | the runner has no memory cap (`Memory=0`, `memory.max=max`) | **closed** | `test/runner-memory.test.ts` M1–M4 |
| 4 | §16 S4 row 2: a list with two `[data-repeat]` children is accepted | **closed** | `test/editor-save.test.ts` S6, S6b |
| 5 | no plugin uninstall/rollback | **closed** | `test/cli-plugin.test.ts` O4, `test/plugin-composed.test.ts` C4 |

---

## 1. First boot must not be a dead site

### 1.1 Reproduced

The QA's first-compose-up failure, on the same `nginx:1.31-alpine`, with a `certs/` directory
holding only the pair `install.sh` used to write:

```
$ docker run --rm -v …/conf.d:/etc/nginx/conf.d:ro -v …/certs:/etc/nginx/certs:ro \
    nginx:1.31-alpine nginx -t
[emerg] cannot load certificate "/etc/nginx/certs/acme.test.crt":
  BIO_new_file() failed (SSL: … No such file or directory …)
nginx: configuration file /etc/nginx/nginx.conf test failed
```

Three independent lies produced it:

1. `app/export/cms.ts` copied `cert_state` from the tenant, so a bundle cut from a tenant that
   had TLS said `issued` — a claim about the **source** box's filesystem travelling to a box
   with none of it. A bundle cannot carry a private key, so the claim can never be true.
2. `tools/nginx_gen.ts` emitted `listen 443 ssl` only for a host whose `cert_state` was
   `issued`, and named `/etc/nginx/certs/<host>.crt`.
3. `install.sh` wrote **one** pair, `certs/default.crt`, into the *bundle*.
4. `docker-compose.yml` ran `nginxproxy/acme-companion`, which looks for `nginx-proxy`'s
   docker-gen container and exits 1 (`can't get docker-gen container id`) against this bespoke
   nginx — so even the certificate that did not exist had no path to being issued.

### 1.2 The fix

- **The claim.** `app/export/cms.ts` writes `cert_state: 'none'` for every exported host. Only
  the `acme` service writes `issued`, after it has written the bytes on *this* host. The bundle
  carries **no** `.crt`/`.key` (`find bundle -name '*.crt' -o -name '*.key'` → 0).
- **The files.** `install.sh` calls `tools/install_certs.mjs`, which reads the hosts from
  `control.db` and mints one self-signed pair per tenant into `<data>/certs/<first host>.crt|key`
  with every host of that tenant in the SAN set, plus `default.crt` for the admin/demos vhosts.
  It mints **only when the file is absent**, so re-running the installer never downgrades a
  CA-issued pair; keys are 0600. Certificates now live in the install's mutable state
  (`./data/certs`), not inside the verified bundle — the QA's defect 9 as well.
- **The listener.** `tools/nginx_gen.ts` emits `listen 80; listen 443 ssl;` for **every** tenant
  block, names `<host>.crt` (a file the install guarantees), and states the truth as a comment
  the operator can read: `# certificate: pending (self-signed until ACME)` or `issued`. It also
  emits the http-01 webroot location in every tenant block.
- **The issuance.** The `acme-companion` service is replaced by `acme/Dockerfile` +
  `tools/acme.mjs`: an RFC 8555 client with no dependencies beyond `node:` built-ins (JWS/ES256,
  nonce retry, order → authz → http-01 → finalize → download; the CSR is DER built in the tool
  because the image has no openssl). It writes the pair, sets `cert_state='issued'`, and sends
  nginx a **HUP** over the Docker socket — a reload, not a restart — finding the container by
  compose labels rather than by the service name (`nginx` is not the container name; the HUP
  used to 404).
- `install.sh` also creates `run/`, `data/scratch`, `data/acme` with modes that work across the
  containers' fixed uids (`plugin-runner` had died with `listen EACCES … /srv/run/plugin.sock`),
  and chowns `data/` to 10001 when run as root.

### 1.3 Proof — the transcript

`scratch/s4e-transcript.sh` (real, not a gate) cut a bundle from a tenant whose control plane
said `issued`, installed it into an empty directory and ran the real compose stack:

```
### 2. the seed the bundle carries (the claim), and the certificates it ships
[ { "host": "acme.test", "kind": "primary", "is_primary": 1, "cert_state": "none" },
  { "host": "www.acme.test", "kind": "alias", "is_primary": 0, "cert_state": "none" } ]
cert files in the bundle: 0
    listen 80; listen 443 ssl;
    ssl_certificate     /etc/nginx/certs/acme.test.crt;
    location ^~ /.well-known/acme-challenge/ {

### 3. install.sh into an empty directory
bundle_verify: 16 file(s) verified …
certificate: pending (self-signed) acme.test for acme.test,www.acme.test
certificate: pending (self-signed) default for admin.skw.test,demos.skw.test
certificates: 2 minted, 0 kept, in …/data/certs

### 5. docker compose up
SERVICE         IMAGE               STATUS
acme            skw-acme:s4e        Up 1 second
app             skw-app:s4d         Up 2 seconds (health: starting)
nginx           nginx:1.31-alpine   Up 1 second
plugin-runner   skw-runner:s4e      Up 2 seconds

### 6. HTTPS GET /pricing, and the certificate that answered
HTTP/1.1 200 OK
Server: nginx/1.31.7
Content-Type: text/html
<html lang="en" data-tenant="acme"> … <h1>acme pricing</h1> …
subject= /CN=acme.test
issuer= /CN=acme.test
notBefore=Oct 20 18:12:10 2026 GMT
notAfter=Oct 17 18:12:10 2036 GMT
SAN: DNS:acme.test,DNS:www.acme.test
--- cert_state in the installed control plane ---
{ host: 'acme.test', cert_state: 'none' }
{ host: 'www.acme.test', cert_state: 'none' }
--- acme log ---
acme: pass failed: connect ECONNREFUSED 127.0.0.1:9
```

The certificate exists, the claim is `none` (printed as **pending**), both facts true at once.
With no CA reachable the service logs the failure and **does not** write `failed` or `issued` —
a transport error is not a CA refusal.

And the same service against **Pebble**, a real ACME server, with validation *not*
short-circuited (the gate `test/first-boot-tls.test.ts` T5):

```
acme-1 | acme: account https://skw-s4e-pebble:14000/my-account/52f8dd4b3799e97d, directory https://skw-s4e-pebble:14000/dir
acme-1 | acme: requesting acme.test, www.acme.test (acme, state none/none)
acme-1 | acme: issued acme.test.crt for 2 host(s); cert_state=issued
acme-1 | acme: nothing to do: 1 tenant(s), every certificate is issued and recent
```

T5 asserts, after that: `domain.cert_state = 'issued'` for both hosts, the file on disk holds
the CA's chain (≥2 PEM blocks), the TLS connection's peer fingerprint **changed**, its issuer is
Pebble, the response is still 200, and nginx's `State.StartedAt` is unchanged — the HUP was a
reload. The images are local (`skw-acme:s4e`, `skw-runner:s4e`, `skw-app:s4d` with this tree's
`dist/` mounted); the published digests do not exist here.

---

## 2. A plugin must be invocable in the product

### 2.1 Reproduced

`grep -rn 'plugins.invoke' app --include=*.ts` found only the class that defines it. A package
could be installed, enabled, tested and exported, and no URL, page or form ever asked it to do
anything.

### 2.2 The fix — D25's declared public surface, wired

- `app/plugins/protocol.ts`: a manifest may declare `endpoints: [{name, method}]`; the name is
  the `op` the package's `handle()` receives, the method is `GET` or `POST`. Validated at install,
  so a malformed endpoint is a refused package rather than a 500 on a tenant's site.
- `app/plugins/endpoint.ts`: `GET|POST /_plugin/<id>/<endpoint>` — tenant from the **Host** (never
  a path, P4), route must be declared, 16 KiB body cap (O-30), JSON only (third-party HTML on the
  tenant's origin is not a v1 promise), and the runner's refusals lifted back into the taxonomy
  (`PL_UNAVAILABLE`/`PL_OOM` are 503, not a bare 500).
- `app/main.ts`: the route. Installed-but-disabled is 503, an uninstalled package or an
  undeclared endpoint is the tenant's **ordinary 404**, byte-identical to a missing page apart
  from the per-request `requestId`.
- `app/plugins/host.ts`: reconnect on demand. `skwctl plugin install` says "restart the runner
  service to load …", and an app that only connected at boot answered `PL_UNAVAILABLE` for every
  plugin until *it* was restarted too — the install → enable → it works path, broken by one
  restart. The stale socket's `close` can no longer clear the new one.

### 2.3 Proof — one HTTP request, two containers

`test/plugin-composed.test.ts` runs `app` on a bridge network and `plugin-runner` with
`--network none --read-only --cap-drop ALL --pids-limit 64 --memory 384m`, sharing only the
`run/` volume, and makes the request the product makes:

```
C1  plugin.sock: bound at /srv/run/plugin.sock (1 package(s): notes@1.0.0)
    runner NetworkMode=none, Memory=384 MiB, socket mode=666
C2  GET  /_plugin/notes/list  -> 200 {"rows":[{"id":1,"body":"written-before-the-request"}],"count":1}
C3  POST /_plugin/notes/sign  -> 200 {"ok":true}
    site.db: cms_plugin_setting(notes, signature) = "signed-over-http"
C4  after uninstall: the same GET is the tenant's 404
```

The row in C2 is read by the **host** from `site.db` inside the invoke the HTTP request
started; C3's write is performed by the host on the package's `skw.call('settings.set')`. The
in-process gate (`E1`–`E5`) covers the same contract with the runner as a host child, the 16 KiB
cap, the 404-not-an-oracle property, and disabled-is-503.

---

## 3. Bound the runner's memory

### 3.1 Reproduced

`docker inspect` → `Memory=0 MemorySwap=0`; inside, `/sys/fs/cgroup/memory.max` → `max`; a
package held 256 MB inside a 1.54 GB VM. §8.4's "it cannot starve the host" had no ceiling to
be true against.

### 3.2 The fix

- `docker-compose.yml`: `mem_limit: 384m`, `memswap_limit: 384m` (equal, or a package escapes the
  ceiling by being paged out), beside the existing `pids_limit: 64`.
- `runner/server.mjs`: children are spawned with `--max-old-space-size=64` (the JS heap), the
  cgroup is the backstop for everything V8 does not count (`Buffer`s), an OOM kill is
  distinguished from the 2 s timeout by the cgroup's `oom_kill` counter and by V8's own
  heap-limit abort, and it is reported as **`SKW_E_PL_OOM`** with the ceiling in the message. A
  dead child is restarted (the QA's §4.8: one slow op used to disable a package until the
  container restarted), with a five-deaths-a-minute limit.

### 3.3 Proof — measured

```
$ docker inspect -f 'Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}}' s4e-mem
Memory=402653184 MemorySwap=402653184
$ docker exec s4e-mem … /sys/fs/cgroup/memory.max
memory.max=402653184
$ docker stats --no-stream
20.11MiB / 384MiB (5.24%)                      # idle: runner + one permission child
$ … memhoard hold 4096
{"id":1,"ok":false,"plugin":"memhoard","code":"SKW_E_PL_OOM",
 "message":"plugin memhoard was killed at the runner's 384 MiB cgroup while running hold"}
$ … /sys/fs/cgroup/memory.peak
memory.peak=384.0 MiB
$ docker inspect -f 'Running={{.State.Running}}'
Running=true                                  # the container survived; only the child died
$ … again, 250 ms later
{"id":2,"ok":true,"plugin":"memhoard","result":{"requested_mb":8,"held_mb":8,"rss_mb":49}}
$ … holdObjects 512 (a JS-object hoard)
{"id":3,"ok":false,"code":"SKW_E_PL_OOM"}
```

Peak **384.0 MiB of 384 MiB** for a 4096 MiB request; the host is not in the blast radius and
the package answers again on the next request. The runner log names the child's heap cap
(`heap=64MiB permission=on`), so the flag is observable rather than asserted from source.

---

## 4. §16 S4 row 2 — one `[data-repeat]` child

### 4.1 Reproduced

`savePage()` accepted a list with **two** `[data-repeat]` children and stored both as row
templates (`items.list` positions 0 and 1). The QA drove it through the production function.
Worse, the corpus fixture `test/fixtures/site/index.html` **encoded** two children, and
`test/editor-save.test.ts` S6 asserted that two rows were stored — the defect was a green test.

### 4.2 The fix

`app/editor/model.ts` `listItems()` — the one reader every path shares (save, load, render,
reload) — refuses more than one repeat child with a **named** code:

```
SKW_E_RT_REPEAT_INVALID  422
a list has 2 [data-repeat] children; exactly one repeat template is allowed
detail: { rule: 'repeat-children', component: 'list', marker: '[data-repeat]', count: 2 }
```

`SKW_E_RT_REPEAT_INVALID` was added to `schema/error-codes.json` and `app/errors.ts` (taxonomy
80 → 82 with `SKW_E_PL_OOM`; `test/error-codes.test.ts` asserts the mirror both ways). Zero
repeat children stays legal: a list with no template renders its `[data-empty]` child.

### 4.3 Proof

`S6` — the corrected fixture (one repeat child) stores exactly one template, and reloads it.
`S6b` — the same document with a second `[data-repeat]` inserted is refused with the code,
status, rule, component and count above, **writes no page row**, and the same document with one
child saves (positive control in the same suite). The fixture's second child and the S6
assertion that depended on it were removed: they were the bug, not a feature.

---

## 5. Plugin uninstall and rollback

### 5.1 Reproduced

`skwctl plugin uninstall` did not exist. `installPlugin()` refuses a different root under the
same id ("uninstall it before installing …"), so a bad or outdated package was permanent short
of hand-editing `cms_plugin_installed` and deleting a root-owned directory.

### 5.2 The fix — the table-scoped archive the register deferred

`uninstallPlugin()` (`app/plugins/install.ts`) + `skwctl plugin uninstall <id> [--archive-dir DIR]`:

1. reads the package's declared tables **from the installed manifest**, re-validating every name
   against the plugin grammar and namespace before it can reach a `DROP`;
2. writes a **table-scoped** archive (`skw-plugin-archive/1`, 0600): each declared table's rows,
   the settings (a `secret` is recorded as existing, never with its value — §8.3's write-only
   rule survives the archive), the registry, migration and installed rows. This is O-40's "v2
   experiment", delivered: restoring it cannot roll back unrelated tenant edits the way the
   whole-file `VACUUM INTO` would;
3. one transaction drops the asset-guard triggers, then the tables, then every registry,
   migration, setting and installed row;
4. after COMMIT, removes `<data>/plugins/<id>`;
5. checkpoints the WAL, so the app's other process sees the new schema on its next request
   (measured without it: one request answered 200 from the pre-drop snapshot).

**The choice, stated:** it archives rather than refusing when data exists. Refusing would make
an operator delete data by hand before removing a plugin they no longer trust; archiving is
reversible and is what §8.6's uninstall row already promised.

### 5.3 Proof

The operator transcript (`notes`, uninstalled from the composed stack after the invocations in
§2.3):

```
$ skwctl plugin uninstall notes --tenant acme --archive-dir …/plugin-archive
plugin: uninstalled id=notes version=1.0.0 root=cf4e41d1… tables=p_notes_note(0) settings=0
plugin: archive …/notes-1.0.0-2026-10-20T18-11-42-790Z.json (0600; table-scoped, restore by hand)
plugin: package removed; its endpoint is 404 from the next request
plugin: restart the runner service to release the code for notes

$ ls -l …/notes-1.0.0-….json        -> -rw------- 2787 B
   format skw-plugin-archive/1 plugin notes tables [('p_notes_note', 0)] settings []
$ rows left behind -> { installed: 0, registry: 0, table: 0 }
$ GET /_plugin/notes/list after uninstall -> 404
```

`O4` is the data-bearing case: it installs `guestbook` with a table and a setting, writes two
rows and one setting, then asserts `tables=p_guestbook_note(2) settings=1`, that the archive is
0600 and `skw-plugin-archive/1` carrying both rows' bodies in order, and that the installed row,
the table, its `cms_table_registry` row, its `cms_plugin_setting` rows and its
`cms_trigger_registry` row are all gone, the package tree is gone, and a second uninstall is
`REFUSAL: PLUGIN_REFUSED: SKW_E_PL_UNAVAILABLE: no plugin "guestbook" is installed`.


---

## 6. Negative controls — six mutations, each restored by hash

Every mutation is a real edit to a product file, the named gate run against it, then the file
restored from a copy and compared by sha256. Logs: `scratch/s4e-mutations/`.
Script: `scratch/s4e-mutations.sh`.

| # | mutation | gate that went red | sha256 before = after |
|---|---|---|---|
| 1 | `app/export/cms.ts`: `cert_state: 'none'` → `h.certState` | T1–T5 (bundle claims `issued`) | `d89ffa60…a050e1` ✔ |
| 2 | `tools/install_certs.mjs`: `mint()` returns false | T2–T5 (no pair; nginx cannot load it) | `90b6d019…a595ed` ✔ |
| 3 | `app/main.ts`: route `/_plugin/*` → `/_plugin-off/*` | E1, E2, E4, E5 | `f61aeee3…6834f1` ✔ |
| 4 | `docker-compose.yml`: remove `mem_limit`/`memswap_limit` | M1–M4 | `477f1753…7ea04f` ✔ |
| 5 | `app/editor/model.ts`: `if (rows.length > 1)` → `&& false` | S6b | `321588b0…fa8294` ✔ |
| 6 | `app/plugins/install.ts`: drop the `DELETE FROM cms_plugin_installed` | O4 | `a4a74b5d…f37d88e0` ✔ |

The red lines are in `scratch/s4e-mutations/*.log`; each shows `exit=1` and the `not ok` names
above. Nothing else in the suite moved: the restored tree is the tree that passes 554.

---

## 7. What changed, and what it changed about the spec

**Product code**

| file | change |
|---|---|
| `app/export/cms.ts` | exported seed always `cert_state: 'none'`; ships `tools/install_certs.mjs` |
| `app/plugins/endpoint.ts` (new) | the D25 public endpoint surface |
| `app/main.ts` | `/_plugin/<id>/<endpoint>` route; one retry on transient SQLite codes (a CLI writing the same `site.db` is a supported shape) |
| `app/plugins/host.ts` | reconnect on demand; a superseded socket cannot clear the live one |
| `app/plugins/install.ts` | `uninstallPlugin()` with the table-scoped archive; WAL checkpoint |
| `app/plugins/protocol.ts` | `endpoints[]` in the manifest, validated at install |
| `app/editor/model.ts` | one-repeat-child validator, `SKW_E_RT_REPEAT_INVALID` |
| `app/errors.ts`, `schema/error-codes.json` | two codes: RT `REPEAT_INVALID` (422), PL `OOM` (503); taxonomy 80 → 82 |
| `app/cli/skwctl.ts` | `plugin uninstall` |
| `tools/nginx_gen.ts` | 443 for every tenant block; per-host cert; http-01 webroot; state as a comment |
| `tools/install_certs.mjs` (new) | per-host self-signed pairs into `<data>/certs`, never overwriting |
| `tools/acme.mjs` (new), `acme/Dockerfile` (new) | the RFC 8555 service |
| `install.sh` | mint per-host pairs; writable `run/`, `data/scratch`, `data/acme`; chown to 10001 when root |
| `docker-compose.yml` | certs/webroot mounts; the `acme` service replaced; `mem_limit`/`memswap_limit` |
| `runner/server.mjs` | heap cap, OOM classification, child restart, socket mode 0666 |

**Two spec statements now say something different, deliberately, and need an errata entry
rather than a silent edit:**

1. **§12.5 / §12.3** said `listen 443 ssl` is emitted *only* when `cert_state = 'issued'`. It is
   now emitted for every block, because the install guarantees a pair for every host; the state
   is a comment beside the block. The old rule's reason ("a 443 block naming a certificate that
   does not exist fails `nginx -t`") is what produced the dead first boot: it made the *listener*
   depend on a claim no file backed.
2. **§8.4 / §13.3** said "one cgroup for all plugins, no per-plugin memory ceiling … it cannot
   starve the host". The claim was false as shipped and is now true by the cgroup; per-plugin
   accounting is still not claimed.

---

## 8. What remains before S4 GO

Closed here: the five blockers, plus the QA's §4.8 (no respawn) and defect 9 (install writes
into the verified bundle) as side effects of the same work.

Still open, in the QA's severity order:

- **Major — §8.5's install screen and signature flags.** `skwctl plugin install` still exposes
  no publisher key, fingerprint, capability list in plain words, table/export list, first-party
  flag, report timestamp or digest. Unsigned is legal, but the trust decision the spec says the
  screen *is* cannot be made from the current output.
- **Major — the runner does not enforce capabilities on host calls.** `forwardHost()` forwards
  whatever the child asks; the app's `host.ts` re-checks and is the only gate. One line in one
  file (defence in depth), not done here to keep this slice's scope to the five blockers.
- **Errata.** The two deviations above need `02-errata.md` entries and the §16 S4 row-12 wording
  updated from "serves on 80 while pending" to "serves 443 with the self-signed pair while
  pending".
- **`make test-perf`** still needs an idle box (the QA's refusal at load 10.72/8 cpus stands; it
  is a measurement precondition, not a code defect).
- **An ACME issuance against a production CA** remains unproven (§13.4 item 1); Pebble is proven
  with validation *not* short-circuited, which is stronger than the spec's own note.

---

## 9. Reproducing

```
make test                                  # 554 / 554 / 0 / 0, exit 0, 161.18 s
node scripts/run-node-tests.mjs --timeout=400000 test/first-boot-tls.test.ts
node scripts/run-node-tests.mjs --timeout=400000 test/plugin-composed.test.ts
node scripts/run-node-tests.mjs --timeout=180000 test/runner-memory.test.ts
node scripts/run-node-tests.mjs --timeout=60000  test/plugin-host.test.ts
node scripts/run-node-tests.mjs --timeout=60000  test/cli-plugin.test.ts
node scripts/run-node-tests.mjs --timeout=60000  test/editor-save.test.ts
bash scratch/s4e-transcript.sh             # the transcript quoted above
bash scratch/s4e-mutations.sh              # the six mutation records
```

Artifacts: `scratch/s4e-transcript.txt`, `scratch/s4e-mutations/` (logs + backups),
`scratch/s4e-first-boot-*.log`, `scratch/s4e-composed-*.log`, `scratch/s4e-runner-memory-*.log`.

---

## 10. S4f — the trust surface, the second capability gate, and two errata

**Verdict: the three items §8 left open are closed, and S4 GO is not blocked by any of them.**
`make test` is green at **566 tests / 566 pass / 0 fail / 0 skipped, exit 0, 178.90 s** (S4e: 554),
`verify-dist` **6/6** and the leak audit clean. No commit was made, no gate was weakened, `SKW_ALLOW_SKIP`
was never set, and no test asserts a wall-clock value outside `test/perf`.

| # | Item | State | The gate that holds it |
|---|---|---|---|
| 1 | §8.5's install screen and D27's signature flags | **closed** | `test/plugin-trust.test.ts` T1–T6; the transcript in §10.1 |
| 2 | the runner does not enforce capabilities on host calls | **closed** | `test/plugin-capability.test.ts` C1–C2b, plus two mutations (§10.2) |
| 3 | E-29 and E-30 | **closed** | `docs/sds/02-errata.md` §13; `make verify-frozen` green |

### 10.1 The trust surface — D27 made real

**What was missing.** `skwctl plugin install` had no `--signature`, no `--publisher`, no `--allow-unsigned`, and
no trust store to consult. `installPlugin()` accepted a `signatureState: 'first_party' | 'imported'` plus a raw
base64 signature **over the root hash only** — and nothing in the product ever passed either. Unsigned was not the
fallback; it was the only path, and the screen §8.5 calls "the trust decision" did not exist.

**What exists now.**

- **`app/plugins/trust.ts`** — `skw-plugin-signature/1`, a detached `plugin.sig.json` beside the package. It is
  detached on purpose: `packageRootHash()` is the package's identity (it is what `cms_plugin_revoked`,
  `BUNDLE.json.plugins[].root_hash` and `tools/bundle_verify.mjs` compare), and a signature file *inside* the
  package would have to be excluded from that walk in three places, where one drifting copy turns every signed
  install into a root mismatch.
- **What the signature covers:** publisher id, key fingerprint, `plugin.json`'s own sha256, the path and sha256 of
  **every file**, and the root over that list. A root alone can only say "something changed"; the file list is what
  makes the refusal name the file.
- **`<data>/trust/publishers.json`** (`skw-trust/1`, 0600) — written by `skwctl plugin trust import <key.pem>
  --publisher <id>` and by nothing else. A different key under an already-imported publisher is **refused**, naming
  both fingerprints, unless `--replace` is passed: a silent key replacement is what a supply-chain swap looks like.
- **One key baked into the image** (`FIRST_PARTY_SPKI_PEM`, Ed25519 SPKI). A package whose publisher is
  `skunkworks` and whose signature verifies against it is `first_party` with no operator action. The constant in
  this tree is a **placeholder that fails closed**: it was generated for this slice and no private half is retained
  anywhere in the repository, so today no package can be signed as first-party — the safe direction, and a
  release-pipeline step rather than a code gap (see §10.5). The gate proves the path with a fixture keypair
  (`firstPartyKeys`, a library-only override) and pins the image key by fingerprint, so replacing the constant is a
  one-line change that no gate has to be taught.
- **Unsigned is refused** (`SKW_E_PL_SIGNATURE`, message names `--allow-unsigned`) unless the flag is passed; with
  it the install is `signature_state='unsigned'`, the banner is printed twice (screen and result line), and the
  audit row carries `allow_unsigned: true`.
- **The screen** (§8.5, before anything is enabled): publisher, key fingerprint and where the key came from, every
  capability in plain words, every table with its export class, settings, public URLs, the test report's timestamp
  and digest, and the root. `inspectPackage()` runs the whole matrix and writes nothing; the CLI prints the screen
  and only then calls `installPlugin()`, which re-verifies and refuses if the bytes changed in between.
- **`tools/plugin_sign.ts`** — the packager's half: `--keygen`, and `--dir/--key/--publisher/--out`. It imports the
  statement builder from `app/plugins/trust.ts`, so the signer and the verifier cannot drift into two canonical
  encodings that agree on the happy path and disagree on a path nobody tests.

**Proof — one operator session** (`scratch/s4f/trust-transcript.sh` → `scratch/s4f/transcript.txt`; real commands,
the fingerprints of that run):

```
### 3. the tenant owner imports A, and the store is 0600
plugin: imported publisher=acme-labs fingerprint=spki-sha256:641e3fb1dc0e1228a3b1fdb52907cd0a7280e9f970ab7f55dbcc8f32ade2b689
plugin: 1 key(s) in …/data/trust/publishers.json (0600); this file is the install's whole trust decision
-rw------- …/data/trust/publishers.json

### 4. install with --signature: the screen, then the install
install screen — notes@1.0.0
  what it is       S4d's third-party reference package: one table, one setting, five declared host ops. …
  publisher        acme-labs
  key fingerprint  spki-sha256:641e3fb1…b689   [imported by the tenant owner into data/trust/publishers.json]
  first-party      no
  signature        ed25519 over 2 file(s), root cf4e41d1…3e96
  test report      2026-10-21T00:00:00.000Z  sha256:eadc8d1918af48bb…  runner sha256:live
  capabilities     5 granted:
                   store.insert    write a row into one of its own tables
                   store.query     read rows from its own tables
                   settings.get    read its own settings
                   settings.set    write its own settings
                   assets.resolve  look up a media library item by key
  tables           p_notes_note  (exports: rows)
  settings         signature (string), api_token (secret, write-only)
  public URLs      GET /_plugin/notes/list, POST /_plugin/notes/sign
plugin: installed id=notes version=1.0.0 root=cf4e41d1…3e96 enabled=yes package=…/data/plugins/notes

### 5. one byte more in index.mjs: refused, naming the file
REFUSAL: PLUGIN_REFUSED: SKW_E_PL_SIGNATURE: the package was edited after it was signed: index.mjs
exit=1

### 6. unsigned: refused without the flag, installed with it
REFUSAL: PLUGIN_REFUSED: SKW_E_PL_SIGNATURE: echo is not signed by any key this install trusts; pass
  --allow-unsigned to install it anyway (the install is audited as unsigned)
exit=1
--- with --allow-unsigned ---
  *** UNSIGNED — no key this install trusts vouches for this package.            ***
  *** You passed --allow-unsigned. The install row is signature_state=unsigned    ***
  *** and the audit chain records allow_unsigned=true.                           ***
plugin: installed id=echo version=1.0.0 root=798ac035…c8d3 enabled=yes
plugin: *** UNSIGNED *** this package is not vouched for by any key; the audit row records allow_unsigned=true

### 7. a package signed by B, while A is the imported key: both fingerprints
REFUSAL: PLUGIN_REFUSED: SKW_E_PL_SIGNATURE: the package was signed by
  spki-sha256:fd512212…fa40 but acme-labs is trusted as spki-sha256:641e3fb1…b689
exit=1

### 8. the rows, and the audit entry for the unsigned install
{"plugin_id":"notes","version":"1.0.0","publisher":"acme-labs","publisher_key_fingerprint":"spki-sha256:641e3fb1…b689","signature_state":"imported","enabled":1}
{"plugin_id":"echo","version":"1.0.0","publisher":"unsigned","publisher_key_fingerprint":null,"signature_state":"unsigned","enabled":1}
audit: plugin.install echo {…,"publisher":"unsigned","publisher_key_fingerprint":null,"signature_state":"unsigned","allow_unsigned":true}
```

`test/plugin-trust.test.ts` is the same four facts as gates, plus two the transcript does not drive: **T2** also
edits `plugin.json` (the manifest is the grant — the refusal names `plugin.json`) and asserts that a file **added**
after signing is refused too, and **T5** asserts the image key's fingerprint is the pinned value and that a package
claiming `publisher: skunkworks` with another key is refused naming both — first-party cannot be self-declared.

**Two limits, stated rather than implied.** (1) `publishers.json` is **one file per install**, not one per tenant,
because §8.5 names `data/trust/publishers.json`; an operator's import is therefore visible to every tenant's
install screen, and the screen says which key it is. Per-tenant trust is a v2 decision, not a silence. (2) The
signature is **detached and is not shipped in an export**: a bundle's integrity claim is `BUNDLE.json` plus the
package root, which is what `bundle_verify` checks. Provenance across a bundle hand-off is not claimed here.

### 10.2 Defence in depth in the runner — and why the second gate is not a copy of the first

`forwardHost()` used to forward whatever the child asked for; `app/plugins/host.ts` re-checked it. One line, in the
process that trusts the package least, for the child that is the least trusted thing in the system — a bug in that
one `if` was the whole distance between a plugin and a tenant's rows.

**What changed.** The grant travels with the invoke: `plugin.invoke` now **requires** `granted: string[]`
(`app/plugins/host.ts` sends the row's capabilities; `endpoint.ts` passes the row it already read; a caller with no
row gets the **empty** set, never the manifest's). `runner/server.mjs` intersects it with its own read of the
manifest — a host can narrow, never widen — stores it on the invoke's binding (it dies with the invoke, so no grant
can leak to the next caller), logs `invoke … granted=N/M`, and `forwardHost()` refuses any op outside it
**before writing a `host.call` frame**. Absence of `granted` is `SKW_E_PL_ROW`, not a fallback: a runner that
defaulted to "the manifest is the grant" could not tell an app that forgot from an app that meant to send nothing,
and the fallback would be the wider of the two.

**The proof is two mutations, each restored by hash** (`scratch/s4f/capability-mutations.sh`, logs in
`scratch/s4f/mutations/`). Each gate fails **only** on the layer it names:

| mutation | C1 (runner) | C1c (intersection) | C2 (host) | C2b (no grant) |
|---|---|---|---|---|
| **M1** runner's `binding.granted.has(op)` disabled | **red** | **red** | green | green |
| **M2** host's `capabilities.includes(op)` disabled | green | green | **red** | green |
| restored (`sha256` identical=yes both) | green | green | green | green |

The red lines are the interesting part:

```
M1  not ok 1 - C1 … 'SKW_E_PL_PLUGIN_ERROR' !== 'SKW_E_PL_REJECTED'
        (with the runner's check gone, the package's store.insert reaches the host, the host answers
         for a table it may write, and the invoke fails later as a plugin error instead)
M2  not ok 4 - C2 … the host must refuse an undeclared op:
        {"type":"host.result","id":"h1","ok":true,"result":{"changes":1}}
        (with the host's check gone, store.delete SUCCEEDS: one row deleted, and the gate's
         post-condition — the row is still there — is what makes that visible)
```

C1 has no `host.ts` in the loop (the test *is* the host, a raw socket client that counts `host.call` frames: zero
for the ungranted op, one for the granted read before it) and C2 has no `server.mjs` in the loop (a fake runner
writes `host.call` frames itself, exactly as a compromised runner would). Neither case can pass by way of the
other. C1b is the positive control that the gate is not "refuse everything": with the op granted, both frames are
forwarded and the invoke succeeds.

### 10.3 Errata E-29 and E-30

Written in the established shape in `docs/sds/02-errata.md` **§13** (four labelled parts per item — defect,
verbatim drop-in, the test that must change, severity — plus builder items and a traceability table):

- **E-29** — §12.5/§12.3's "`listen 443 ssl` only when `cert_state='issued'`" is what produced the dead first boot:
  a bundle cannot carry a private key, so a cold install is `pending` by construction, so the old rule left no 443
  listener at all and never used the self-signed pair the installer mints. The drop-in makes both listeners
  unconditional and the state a comment, and it names §16's S4 row 12 as owed text ("serves on 80" → "serves 443
  with the self-signed pair while pending").
- **E-30** — §8.4's "Cost, accepted" and §13.3's first bullet both assert "it cannot starve the host" while
  `Memory=0` and `memory.max=max`. The drop-ins state the real bound (one shared cgroup at 384 MiB, no swap escape,
  `PL_OOM` naming the ceiling, container survives, child restarted) and keep the honest limitation: per-plugin
  **accounting** is absent and is not claimed.
- Neither supersedes a frozen contract: `check_frozen.py` quotes neither sentence and still reports
  `pointers: 23/23` (§13's item 5 moves `range(1, 24)` → `range(1, 31)`, landing E-24..E-30's owed pointer lines,
  because E-28's item 8 has not run).

### 10.4 What changed

| file | change |
|---|---|
| `app/plugins/trust.ts` (new) | `skw-plugin-signature/1`: statement, verify (signature → key → every file → root), trust store (`skw-trust/1`, 0600), import/refuse-on-replacement, the image key, `CAPABILITY_TEXT` (14 ops in plain words), `installScreen()`, `trustDirFor()` |
| `app/plugins/install.ts` | `inspectPackage()` = §8.5's matrix with no writes, in the spec's order (signature, revocation, report, schema, export class, downgrade); `allowUnsigned`; `InstallResult` carries `signature_state`/`publisher`/`publisher_key_fingerprint`/`unsigned`/`screen`; the root is recomputed before writing and a change refuses; uninstall now **reads** `wal_checkpoint`'s `{busy}` result and retries instead of trusting a `try/catch` that could never fire (§10.5) |
| `app/plugins/protocol.ts` | §8.1's optional `publisher` block, validated (`id`, `key_id` as `spki-sha256:<64 hex>`) |
| `app/cli/skwctl.ts` | `plugin trust import|list`; `install --signature/--allow-unsigned`; the §8.5 screen printed **before** the install; the audit row gains `publisher`, `publisher_key_fingerprint`, `signature_state`, `allow_unsigned` |
| `app/plugins/host.ts` | `invoke()` sends `granted`; a caller with no row sends `[]`; `grantFor()` reads the row when the caller did not |
| `app/plugins/endpoint.ts` | passes the row it already read as the grant |
| `runner/server.mjs` | `plugin.invoke` requires `granted`, intersects with the manifest, binds it to the invoke, logs `granted=N/M`; `forwardHost()` refuses outside it before any `host.call`; the stale "host client is not wired" header comment corrected |
| `tools/plugin_sign.ts` (new) | `--keygen`, and signing from the same statement builder the verifier uses |
| `test/plugin-trust.test.ts` (new) | T1–T6 |
| `test/plugin-capability.test.ts` (new) | C1, C1b, C1c, C2, C2b |
| `test/plugin-host.test.ts` E6 (new) | the strict uninstall ⇒ 404 on the first request, on a coherent filesystem (§10.5) |
| existing gates | `plugin-host` P1/P6, `plugin-composed`, `cli-plugin` O1/O3/O4 and the four raw-socket invokes now **state** what they relied on silently: `allowUnsigned: true` where the package is unsigned and the case is about something else, and `granted: []`/`['store.query']` on the wire. No assertion was loosened; P4's message moved to the layer that now answers it (`… granted capabilities at the runner`), and C2 covers the host's own refusal with no runner present |

### 10.5 What remains open

Everything §8 listed that is not one of these three is unchanged: a production-CA issuance (§13.4 item 1 — Pebble
with validation *not* short-circuited is proven, which is stronger than the spec's own note), and `make test-perf`,
which still needs an idle box (a measurement precondition, not a defect).

**One flake, found by running the suite through the harness, diagnosed, and split in two.** `C4`
(`plugin-composed.test.ts`) failed **twice in ~9 full-suite runs** and **0 times in 8 runs of its own file**: after
`uninstallPlugin()` the composed app still answered `200` for the removed endpoint. A diagnostic added to the
assertion settled which of the two possible causes it was — the failure message now prints both views:

```
C4 … AssertionError [ERR_ASSERTION]: host: row=gone
  200 !== 404        (the app container answered with the row the host had already deleted)
```

So the uninstall committed and this process sees it; the *container* read a page cache that had not observed the
host's DDL commit — Docker Desktop's virtiofs, not a Linux bind mount and not the product. Two things came out of it:

1. **A real defect next door, fixed.** `uninstallPlugin()` wrapped `PRAGMA wal_checkpoint(TRUNCATE)` in a
   `try/catch` on the belief that a busy reader throws; the pragma **returns** `{busy, log, checkpointed}`, so that
   catch could never fire for the reason it named and the one guarantee the uninstall makes to the other process
   could be skipped silently. The result is now read and the attempt repeated while `busy` (25 × 20 ms), and the
   catch is reduced to the hard error it actually covers.
2. **A strict twin, and a bounded allowance only where the boundary exists.** The one-shot property is now asserted
   with no retry and no pause in **`plugin-host.test.ts` E6**, where the app is a Fastify instance in the same
   process and the database is on the same filesystem: the *first* request after the uninstall is the tenant's 404,
   byte-identical to a missing page, while the runner still holds the package. C4 keeps the cross-container case and
   re-reads for at most a second — **only** when its own connection already reports `row=gone`; if the row is still
   present in this process, or the app has not caught up within that second, C4 is red. That is the narrowest form
   that separates "the uninstall did not happen" from "the container's cache has not seen it", and the strict form
   is asserted where the filesystem can honour it.

Newly named, and none of them a S4 blocker:

- per-tenant trust is not modelled (`publishers.json` is one file per install, §8.5's own path);
- **the image's first-party key is a placeholder with no retained private half**, so first-party packages cannot be
  signed until the release pipeline bakes its own public key into `FIRST_PARTY_SPKI_PEM` (`plugin_sign --keygen`,
  keep the private half, replace the constant). It fails closed — an unsigned or wrongly-signed package is refused
  as `imported`/`unsigned`, never granted as first-party — and no first-party package exists in v1;
- `data/trust/revoked.json` is named by §8.5 and has **no writer** — revocation is `cms_plugin_revoked` today, so
  the file is a second source of truth waiting to disagree with the first (recorded in §13's traceability);
- a signature does not travel in an export; the bundle's root and `BUNDLE.json` remain the integrity claim;
- the runner still holds its package list from boot, so `install`/`uninstall` say "restart the runner service".

### 10.6 Reproducing

```
make test                                                        # 566 / 566 / 0 / 0, exit 0, 178.90 s
node scripts/run-node-tests.mjs --timeout=180000 test/plugin-trust.test.ts
node scripts/run-node-tests.mjs --timeout=180000 test/plugin-capability.test.ts
bash scratch/s4f/trust-transcript.sh > scratch/s4f/transcript.txt # the session quoted in §10.1
bash scratch/s4f/capability-mutations.sh                         # M1/M2 and the hash-identical restore
```

Artifacts: `scratch/s4f/transcript.txt`, `scratch/s4f/mutations/{M1-runner-check-disabled,M2-host-check-disabled,
after-restore}.log`, `scratch/s4f/mutations/{server.mjs,host.ts}.backup`, `scratch/s4f/make-test.log` (the 565 run).
`scratch/s4f/pubA.{key,pub}` are the transcript's throwaway publisher keys — the image key's private half is
deliberately not kept anywhere (§10.5).
