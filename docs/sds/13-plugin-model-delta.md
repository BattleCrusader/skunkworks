# 13 — Plugin model delta: what a reader of the old §13 must forget

**Status:** reader-facing companion to `SDS.md` §13 (rewritten) and `02-errata.md` E-31..E-33.
**Decision of record:** `IDEA.md` **D36** — plugins load **in-process inside the website container,
WordPress-style**. D36 supersedes **D26** and the fourth-compose-service decision.
**Date:** 2026-10-21.

This file exists because §13 was not edited, it was **inverted**. A reader who learned the old section will
carry six sentences that are now false in the direction that matters — they describe a boundary where there is
none. Those sentences are listed here so they can be unlearned deliberately rather than discovered in a review.
If you only read one line: **plugins are not contained, and no part of this design contains them.**

---

## 1. Forget these seven things

| # | The old claim (and where it lived) | What is true now | Read instead |
|---|---|---|---|
| 1 | "`docker-compose.yml` has four services: `nginx`, `app`, `plugin-runner`, `acme`." (§3, §12.1, C-8) | **Three services.** `plugin-runner` is deleted, with its Dockerfile, its `network_mode: none`, its `cap_drop`, its `pids_limit: 64` and its 384 MiB cgroup. | `SDS.md` §12.1, §13.3.9 |
| 2 | "Plugins are reached over a 14-operation RPC enum on `run/plugin.sock`, JSON lines." (§8.3) | **No socket, no frames, no `granted[]` envelope.** The 14 operations survive as **methods on a per-request facade**; their bounds survive because a bound belongs to the operation, not the transport. | `SDS.md` §8.3, §13.3.5 |
| 3 | "No plugin code is on the render path; a broken plugin cannot take a page down." (§8.6, §13.3) | **Exactly backwards.** A plugin's filter runs inside the render call. A plugin that **throws** cannot take a page down (the dispatch catches and uses the value passed in); a plugin that **blocks** takes the whole box down. | `SDS.md` §13.3.4, §13.3.6 |
| 4 | "A 2 s per-op timeout and a circuit breaker bound the damage to the endpoint." (§8.6, §13.3) | **No timeout exists** for the case that matters. A `Promise.race` reclaims an async hang; nothing reclaims a synchronous loop, because the timer needs the event loop the loop is holding. The "circuit breaker" is a 3-failures-in-60-s **auto-disable with operator recovery**, with no half-open state. | `SDS.md` §13.3.6 |
| 5 | "The containment (§8.4) is real: no network namespace, no native addon, no child process, no database handle." (§13.3) | **There is no containment.** A plugin shares the app's network namespace, filesystem, memory and handles. It can read `data/control.db` — every tenant's data — with five lines of its own code. | `SDS.md` §8.4, §13.3.7 |
| 6 | "A capability the manifest does not declare cannot be done at runtime." (§8.1, §13.1 P3) | True **of the facade**, false of the code. Capabilities are **disclosure**: what the operator is shown, and what the facade checks before answering a method. They do not limit what the plugin can do — it can ignore the facade entirely. | `SDS.md` §13.3.1, §13.3.7 |
| 7 | "The two layers see one value and the second one does not depend on the first." (`endpoint.ts:97–99`, §8.3's design) | **One layer.** The runner's `binding.granted` check is deleted with the runner. What replaces the second layer is a **mutation test** of the first — delete the check and `test/plugin-scope.test.ts` S3 must go red while the tenant-binding cases stay green. | `SDS.md` §13.1a, §13.3.7 |

Two smaller deletions that are easy to miss:

- **`SKW_E_PL_OOM` is withdrawn, and E-30 is withdrawn with it.** E-30 spent an item giving the runner a 384 MiB
  cgroup and a `PL_OOM` refusal; there is no runner to bound. The only memory ceiling now is `mem_limit` on
  `app`, and an OOM kill takes every tenant down (`SDS.md` §13.3.6). E-30's *measurement discipline* survives
  even though its subject does not: a ceiling is asserted where it is enforced, or it is not claimed.
- **`BUNDLE.json.image.runner_digest` is deleted.** One image, one digest (`SDS.md` §11.5, §12.6).
- **`§13.4` item 2 ("the composed plugin path across two containers") is withdrawn.** There is one container; the
  path is measured directly (`SDS.md` §13.4).

---

## 2. What a signature now buys — and what it does not

This is the paragraph most likely to be misread, so it is stated twice: once here, once in `SDS.md` §13.3.7, and
once in the operator's words on the install screen.

| Claim | True? | Because |
|---|---|---|
| these bytes were signed by the holder of this key | **yes** | Ed25519 over the package root, verified at install **and again at load** |
| the package has not changed since it was signed | **yes** | root hash recorded; a package edited on disk refuses to load (`SKW_E_PL_SIGNATURE`) |
| this plugin cannot read another tenant's database | **no** | it is in the process, with the process's own credentials |
| this plugin cannot block the event loop | **no** | nothing can interrupt a running function in the same thread |
| this plugin will only use the capabilities it declared | **no** | the facade checks the declaration; the code can bypass the facade |

**A signed plugin and an unsigned one have identical power at runtime.** The signature buys **author identity**
and **tamper detection**. It buys **no containment, not even a little**. Any document, screen or commit message
that lets a reader infer otherwise is a defect against E-33.

C-8's frozen sentence — the one the SDS was required to quote verbatim — is retired by E-31 through
`scripts/model/check_frozen.py`, which now asserts the *old* text is absent, the replacement present verbatim,
and the marker present. That is how a frozen contract is retired: by an errata the checker knows about, not by
deleting a sentence and hoping the gate is asleep.

---

## 3. What did *not* change (do not over-forget)

A delta that deletes too much is as expensive as one that deletes too little. These survive intact:

- **The manifest is still the contract** — `id`, `version`, `cms` range, `publisher`, `tables` + export class,
  `settings`, `admin` screens (declarative only), `public` endpoints, `capabilities`, `tests`, `cron: none`.
  Two fields are **added**: `main` (what to `import()`) and `hooks` (what it may register).
- **The host still writes every row.** A plugin describes a row; it never holds a `Database`. `p_*` tables are
  still created by the host executor inside one `BEGIN IMMEDIATE`, with the `asset_key` guard trigger, and the
  four-op forward-only migration grammar still has no `drop_table`, `rename_table` or `drop_column`.
- **No publisher CA (D27).** Our key verifies first-party packages; a third-party key is imported by the tenant
  owner, fingerprint shown beside every capability; revocation is local to the install.
- **Install still refuses** an unknown signature, a revoked root, a stale test report, a CMS-version mismatch, a
  table with no export class, and a destructive migration — in that order. The test report now names the **app**
  image digest.
- **Disable still loses no data; uninstall still archives the whole tenant file first**, then drops the plugin's
  tables. A downgrade is still refused; uninstall-then-install is the only path.
- **The install-time test run still happens**, now in the app image. It is the only place a package's behaviour
  is exercised before an operator enables it — which matters more than it used to, because there is no sandbox to
  catch it afterward.

---

## 4. What the new §13 adds that the old one had no place for

The old model had no runtime to describe beyond "ask the runner", so these are new obligations rather than
replacements:

1. **The load path** (`§13.3.2`) — `import()` with a **cache-buster** (`?tenant=…&act=<n>`). Without it, a
   disable→enable cycle returns the old module namespace with its timers and module state alive, and "not loaded"
   is a lie. One module instance per (tenant, plugin, activation) also stops module state crossing tenants.
2. **The registry** (`§13.3.3`) — per tenant, prunable in one operation, snapshotted per dispatch, closed to
   registration after activation. Disable **removes** the hooks; it does not set a flag that a later refactor can
   invert.
3. **The hook surface** (`§13.3.4`) — twelve named hooks, six filters and six actions, frozen. A filter may change
   **only the value it was handed**: not status, not headers, not cookies, not the route. `download.authorize` is
   absent by decision, so no plugin can grant a paid download.
4. **The per-request scope** (`§13.3.5`) — a frozen facade, `render-read` in render and `admin-write` in admin and
   endpoints, bound to the tenant this request resolved, with no tenant parameter anywhere, `ATTACH`
   unexpressible, `database_list = ['main']` asserted, and a stubbed facade refusing `SKW_E_PL_CONTEXT_ENDED`.
   Never the `control.db` handle.
5. **The failure model** (`§13.3.6`) — load-time and per-request `try/catch`, a failed plugin marked `failed` and
   disabled with an admin notice while the site serves, and **the accepted cost** in a block quote: a synchronous
   hang cannot be timed out in-process and nothing here mitigates it.
6. **Lifecycle without a restart** (`§13.3.8`) — enable is all-or-nothing, disable prunes, uninstall drains
   (5 s, then `SKW_E_PL_BUSY`), and module-level state dies on disable by design.

---

## 5. If you are about to…

- **…build the runner.** Don't. `runner/**`, `Dockerfile.runner` and the `plugin-runner` service are deleted, not
  deferred. `grep -r plugin-runner` should return this file, `SDS.md` §13.3.9 and the errata.
- **…write a capability check.** Put it in `app/plugins/context.ts`, make it read the grant from
  `cms_plugin_installed` **inside the request**, and write the test that goes red when you delete it. Then write
  the install-screen sentence that says it is not a sandbox.
- **…write a timeout.** Say out loud what it can and cannot interrupt. A `Promise.race` around an `await` is a
  real bound on an async hang and a decoration around a synchronous one.
- **…write "cannot".** Check it against §13.3.7 first. The model's honest verbs are *does not* and *is not
  defended against*.
- **…review this for security.** Start at §13.1 P3, P5, then §13.3.7, then §13.4 item 5. If you find a sentence
  that promises containment, it is a defect, and E-33 is the item that owns it.
