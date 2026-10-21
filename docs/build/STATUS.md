# Skunkworks — Status

**As of 2026-10-21 04:0x AEDT.** Branch `main`, HEAD `aaff12b`, tree clean.
Multi-tenant Astro CMS. Spec-first: `IDEA.md` (30+ decisions) → `docs/sds/SDS.md` (2,089 lines, 18 sections) → errata → build, one slice at a time, every slice gated.

---

## Slice status

| Slice | State | Gate evidence |
|---|---|---|
| **S1** hosting core | ✅ QA GO | tenancy sweep, real-nginx e2e, admin 404-on-tenant-host (110 combos, 0 oracle) |
| **S2** admin + data plane | ✅ QA GO | CSRF 12/12, DDL rollback by schema digest (53 objects), plan-based publish refusal, segment audit seal |
| **S3** assets + downloads | ✅ QA GO (2 rounds) | one use per token under 8 parallel ranges (3 ways), fail-closed watermarking under real faults, gated 404 byte-identical to missing |
| **S4** editor + exporters + install + plugins | ✅ **GO** (mechanism) | 597 tests, 10/10 components survive a real browser, 3 exporters byte-identical, install 21.2 s, 12/12 hooks live, 2,908 lines of containment deleted, 22 mutations each red only under its own assertion |

**597 tests · 0 skipped · `hermes verify` ok=true · zero leaked containers · four consecutive green runs at load 4.8-8.9.**

---

## The numbers that are measured, not claimed

**Install (D30's five-minute promise)** — 1.2 s machine + 20 s human (one TOTP scan) = **21.2 s of 300 s**, clean dir to `GET /` 200 `"Acme home"`. Second run 0.17 s. *Excludes* image pull and TLS; `docker compose up` exits 17 on the pinned ghcr digest (absent locally), so the registry path is **unproven**.

**Export determinism** — each tree reproduced identically by a second export at the same `SKW_EXPORT_NOW`:
```
static  de33dff92a26e0fe66173a00cd5c5c840963707acdf0e973846f5f77ac26bcef
astro   9dda7f78e993d59ac2136b795abc6afa2c566ab4928422c00ff11cd702fae67a
cms     42fd728d5b53838d619224b74a75a38cf23e9a73afd12d550b3b7d140aaf1859
```
mtimes pinned; at +1 h only `EXPORT-NOTES.md` + declared `export_now` differ.

**Download accounting** — 8 parallel Range requests → `uses=1`, one row; 8 separate OS processes → 1 spent + 7 continuations; 8 ranges through real nginx → 8×206, one row. Two tokens → 2 uses.

**Watermark failure policy** — forced renderer error and forced 2 s overrun each → 503, `denied_watermark`, **no** `X-Accel-Redirect`, **no** `Content-Disposition`, `uses=0`. Concurrency: 24 concurrent across 4 tenants → peak 8 in flight (was 32), 0 served after 2000 ms. False refusals: **0%** at 10/20/40 buyers per minute; **28-42%** at 32-48 *simultaneous* (D34: retryable, `Retry-After` computed, `uses` never lost).

**Plugins (D36 — in-process, WordPress-style)** — a plugin is a module imported into the app process; there is no runner service, no socket and no boundary. 2,908 lines of containment were deleted on 2026-10-21. What remains: signatures and publisher keys (author identity and tamper detection, **not containment**), a per-request frozen facade with `render-read`/`admin-write` handles bound to the tenant, `ATTACH` unexpressible plus a `database_list=main` assert, and 12 named hooks. Revocation is read from `revoked.json` **and** `cms_plugin_revoked` at install **and at enable**, so a plugin is revocable without uninstalling. A revoked root: install exit 1 `SKW_E_PL_REVOKED`; enable throws with the row left `enabled=0`. Unsigned packages record `publisher='unsigned'` with any claimed name quarantined. A synchronously hanging plugin **cannot be timed out in-process** — accepted cost, stated in the spec.

---

## What was proven by breaking, not asserting

- **Export shares the site's render path** — one line in `app/render/body.ts` reddens the served-page gate **and** all three export gates, roundtrip stays green. This is how the site's never-calling-`renderBody` bug surfaced (`<img data-asset-key>` with no `src`).
- **The fixpoint gate drives the production route** — revert `savePage()`'s unwrap and the gate fails 4/6 with *"the stored bytes are a document, not a fragment"*.
- **The `dist` gate covers a class the node suite cannot** — an excluded worker emit: `verify-dist` RED at D3 while all 417 node tests are green.
- **The occurrence-scoped register** — a 9th runtime-path site appended to `main.ts` goes red: `unclaimed path sites: app/main.ts:715 process.cwd()`, `4 found / 3 claimed`.
- **DDL rollback** — schema digest over 53 `sqlite_master` objects identical after a batch failing on its 3rd statement.
- **Container leak** — the audit creates `skw-leak-probe`, skips its teardown, names it, then goes clean.

---

## The one lesson worth carrying forward

**Four gates today were testing a path one step to the side of what ships.**

| Gate | Tested | Production did |
|---|---|---|
| `bundle_verify` | bundles without renders, exit 0 | could ship a bundle with a live render |
| all node tests | TypeScript in-process | `dist/`, where a `.ts`-only worker URL 503'd every download |
| fixpoint gate | a helper that called `unwrapBody()` | the real save path, which didn't |
| site render | `renderBody()` in tests | served `<img data-asset-key>` with no `src` |

Not one was a missing test. Each was aimed wrong. **Assert on the wire, not on the source.**

**And a fifth, found in the last hour: a gate can be perfectly pointed and still tell a lie.** `skwctl plugin install` printed *"capabilities none — it can reach neither this site's data nor its mailer"* for a zero-capability package, while in-process a plugin can `import better-sqlite3` and read `data/control.db`. Nothing failed, because nothing asserted that the operator-facing text matched the architecture. The fix is a gate that **parses the required sentence out of the errata file and asserts it character for character** — doc and CLI can no longer drift apart. **Assert on the reassurance, not only on the mechanism.**

---

## The plugin model (corrected 2026-10-21)

Plugins run **in-process inside the website container, WordPress-style** (D36) — the user overruled the contained sidecar. Deliberately accepted: a synchronous hang cannot be timed out; a signature buys author identity and tamper detection, **not containment**. Scoping is the per-request facade plus a prunable registry, not a sandbox.

## Open — honestly uncovered

1. **§16 S4 row 12** (clean-host install with images present) — no released image exists; the local leg is 841 ms and is not that row's condition.
2. **The synchronous-hang claim** — verified by reading `withTimeout` and the spec, never by hanging the suite. It is a documented cost, not a tested behaviour.
3. **Per-instance plugin memory** — 25 KiB measured on an earlier tree, not re-measured at `05a23e8`.
4. **ACME against a production CA** — proven against local Pebble with validation not short-circuited; no real CA.
5. **Registry pull** — compose driven with locally built images; the pinned `ghcr` digest is unproven.
6. **Known environment flake** — Pebble `invalid anti-replay nonce` in `first-boot-tls` T5, seen once in several runs, green on rerun.

## Deferred (registered, with owners)

Upgrade channel · public upload intake · table-scoped uninstall archive · scheduled plugin work.

---

## Run it

```
make test           # 534 tests + verify-dist + no-leak, deterministic (perf split out)
make test-perf      # timing/rate assertions, behind a load preflight
make verify-dist    # D1 boot · D2 page · D3 download · D4 migrate · D5 skwctl · D6 nginx_gen
make verify-claims  # re-derives every measurement the docs cite
make verify-frozen  # SDS quotes the register verbatim
```

Docs: `docs/sds/SDS.md` · `docs/sds/00-adjudication.md` (25 conflicts, 44 objections) · `docs/sds/02-errata.md` (E-1..E-28) · `docs/build/S{1,2,3,4}*-report.md` + the QA reports.
