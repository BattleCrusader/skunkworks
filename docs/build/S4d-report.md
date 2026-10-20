# S4d — report, and the repair after the iteration cap

**Status: green.** `make test` → **534 tests, 534 pass, 0 fail, exit 0** (2026-10-21, this
tree). S4d itself hit its iteration cap mid-fix and left the tree red: 531 tests, 506 pass,
25 fail, exit 2. This file is the record S4d owed plus the repair; every claim below is
from a real run, not from S4d's notes.

## 1. What S4d left red, and why

| # | Failure | Cause |
|---|---|---|
| 23 | `nginx-e2e`, `nginx-gated-e2e`, `nginx-media-e2e`, `onboarding` — every test in the files | S4d added `listen 443 ssl` **and** `ssl_certificate`/`ssl_certificate_key` to every generated block. The harness stripped only the `listen` line, so nginx read `/etc/nginx/certs/<host>.crt`, which the test container never mounts, and exited at config parse. `before()` threw; no product code was at fault. |
| 1 | I5 — install refused a bundle with a plugin row, but on `source_counts`, not on the plugin | The fixture edited `site.db` after the export and resealed only its hash, leaving `BUNDLE.json source_counts.cms_plugin_installed = 0`. The quiescence check fired before the plugin check, so the refusal under test never ran. |
| 1 | I5b — exporter refused, but the fixture row's `manifest_json` was not a manifest | `{"id","version"}` has no `entry`; `parseManifest()` threw (exit 1) before the export could decide anything. |
| — | `island-ua` — `ENOTEMPTY` in teardown | Chrome helper processes still write under the profile after the browser is `SIGKILL`ed. A cleanup race, observed only at full-suite scale; it turned a passing gate red. |

## 2. The nginx harness — **strip every `ssl_*` directive**, in one shared helper

`test/helpers/nginx.ts` now owns the two adaptations and nothing else:

* `listen … 443 …` → removed (keeps the `listen 80` half of `listen 80; listen 443 ssl;`).
* **every `ssl_*` directive → removed** (certificate, key, and any future `ssl_protocols`,
  `ssl_ciphers`, `ssl_session_cache`, `ssl_stapling`).
* `proxy_pass http://app:3000;` → `http://<docker-gateway>:<host port>`.

**Why strip rather than mint a self-signed pair and mount `/etc/nginx/certs`:**

1. TLS is not the subject of any of these gates — they test prefix stripping, media
   aliasing, gated hand-off and onboarding reload. A handshake adds a CA the test must
   trust and an expiry that would one day fail on its own.
2. `certs/` is **install.sh runtime state**, not a repository artefact (gitignored). A
   harness that depends on it reintroduces a host dependency and an `openssl` requirement
   into a suite that otherwise needs only Docker.
3. Keying on the `ssl_` **prefix** is what makes a future 443 block safe. S4d's breakage was
   a rule that named one directive (`listen 443 ssl`) and not its siblings; the new rule
   cannot miss a sibling.

The strip is **asserted, not assumed**: `prepareAppConf()` fails if any `listen …443…` or
`ssl_*` directive survives, and if the `proxy_pass` substitution does not hit exactly the
number of upstream lines that were generated. The returned counters (`tlsListens`,
`sslDirectives`, `upstreams`) still let each gate assert the generator emitted the shape it
claims — e.g. `nginx-e2e` requires ≥4 TLS listeners, ≥8 ssl directives, ≥4 upstreams.

All four files (`nginx-e2e`, `nginx-gated-e2e`, `nginx-media-e2e`, `onboarding`) now call
the helper; the duplicated `hostGatewayIPv4()` and `nginx.conf` text are gone. Verified:
**23/23** tests in those files pass, exit 0.

## 3. I5/I5b — a **supersession**, two-sided, with a negative control

**Old contract (S4b/S4c):** any bundle carrying `cms_plugin_installed` rows is refused,
because `planCms()` had nothing to ship (`plugins: []`).

**New contract (S4d):** a row is a claim; the package is the code; the root hash is the
bridge. The verifier is two-sided:

* rows **with** a package at `data/plugins/<id>/`, bytes hashing to the row's `root_hash`,
  and a test report when enabled → **ship and install**;
* rows **without** a package → **refuse**, naming the plugin **and the row**.

Neither test was deleted; both were re-specified.

**I5 (install side), `test/install-bundle.test.ts`** — one test, two halves:

1. *positive*: `make({ pluginPackage: { id: 'contact' } })` exports a bundle with the row
   and the bytes; `install.sh` exits 0, `bundle_verify` accepts it, the installed tenant
   database has the row, and `data/plugins/contact/index.mjs` exists on the host.
2. *negative control*: the **same bundle** with only the package removed (directory gone,
   its `files[]`/`plugins[]` entries removed, the row and `source_counts` kept) exits 12
   with `plugin contact (cms_plugin_installed row 1) has no package`, and creates no
   `control.db`. The positive half is load-bearing: a verifier that refused *every* plugin
   bundle would pass the old test and still be wrong.

**I5b (export side)** — also two halves:

1. *positive*: `BUNDLE.json.plugins` equals `[{id, version, root_hash: <the install row's
   root_hash>, package: "data/plugins/contact", files: 2}]` — the row's own hash, not a
   recomputation — and `tools/bundle_verify.mjs` on the exporter's output exits 0.
2. *negative control*: a tenant with the row and no `<data>/plugins/<id>` is refused by the
   exporter with exit 20, `SKW_E_PL_EXPORT_PACKAGE_MISSING`, and detail
   `{"row":1,"id":"contact",…}`; no `BUNDLE.json` is written.

Supporting changes: `InstalledPlugin` now carries `id`; `PluginPackage` carries `row`; the
exporter's refusal message and detail name the row (`plugin contact (cms_plugin_installed
row 1) has a row but its package cannot be shipped: no package at …`). Fixtures gained
`makeBundle({ pluginPackage })`, which writes a real package and computes `root_hash` with
the product's own `packageRootHash()`, so the positive side is the shape a correct producer
writes rather than a hand-assembled imitation.

## 4. The operator surface that was missing — `skwctl plugin`

S4d's `installPlugin()` was a library entry point with no admin route and no CLI, so a
plugin could not be installed on a running box. Added to `app/cli/skwctl.ts`:

```
skwctl plugin install <dir> --tenant <key> [--test-report <path>]
                            [--runner-digest <sha256:…>] [--enable]
skwctl plugin enable  <id> --tenant <key>
skwctl plugin disable <id> --tenant <key>
skwctl plugin list    --tenant <key>
```

It is a CLI verb, **not** an HTTP route: the package tree is root-owned and mounted
read-only into the app; the admin surface belongs to the tenant's owner, not to the
account that can write `/srv/plugins`. Every successful install/enable/disable writes a
`cms_audit` row with `actor_label = 'skwctl'`. `enable` refuses a package with no test
report or no bytes on disk — the same two preconditions `assertEnabled()` enforces at
render time — and `install` prints that the runner scans its plugin directory at start, so
the service must be restarted to load the new code.

**Proof, end to end (`test/cli-plugin.test.ts`, 3 tests):** operator runs `plugin install`
→ row `enabled=1`, package at `<data>/plugins/contact`; the same tenant is then exported →
`BUNDLE.json` names the installed root hash, the bundle carries the package, and
`bundle_verify` exits 0 (a client can install it). Then `disable` → `enabled=0`, `enable` →
`enabled=1`, an enable with the test report removed is refused (`PLUGIN_REFUSED`) and
flips nothing, and unknown plugin / missing `--tenant` / untested package are named
refusals (exit 1) that write nothing. The test failed first for the right reason
(`unknown command plugin install …`) before the verbs existed.

## 5. Final gate

```
$ make test
# tests 534
# pass 534
# fail 0
# skipped 0
EXIT=0
```

`make test` runs `verify-toolchain verify` (schema, claims, frozen, S1 build+typecheck+node
suite, dist gate, container-leak audit with its own negative control). No skip was set:
`SKW_ALLOW_SKIP` is untouched and `SKW_SKIP_DOCKER` is not exported. The node suite grew
from 531 to 534 with `test/cli-plugin.test.ts`.

## 6. Still open for S4 GO

1. **Runner reload is manual.** `skwctl plugin install` prints the instruction but does not
   restart the runner (and should not: it is a compose action). There is no health signal
   that says "package on disk, not loaded"; until the runner restarts, an enabled plugin
   refuses at render. A `skwctl plugin status` that compares the row against the runner's
   registry would close this.
2. **No `plugin uninstall`.** §8.2's only downgrade path is uninstall-then-install; only
   enable/disable exist. A row cannot be removed through the operator surface.
3. **Signature flags are not exposed.** `installPlugin()` supports `first_party`/`imported`
   with SPKI keys, but `skwctl plugin install` offers no `--signature`/key input, so the
   CLI can only install **unsigned** packages today.
4. **No TLS gate.** The generator emits `listen 443 ssl` and install.sh writes
   `certs/default.crt`, but every e2e gate strips TLS by design. A wrong certificate path or
   an unreadable key in production config is invisible to this suite (it would only surface
   when nginx restarts on a real box).
5. **Refusals are not audited.** Successful install/enable/disable write `cms_audit` rows;
   a refused enable (no test report, missing package) writes a stderr line but no audit row.
6. **One tenant per command.** There is no `--tenant all`; a fleet install is a loop the
   operator writes.
7. **Ownership/mode of copied packages** is whatever the invoking account has. Compose
   mounts `/srv/plugins:ro`, which is correct for a root-run CLI, but the requirement is not
   asserted anywhere.
