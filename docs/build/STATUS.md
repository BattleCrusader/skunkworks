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
| **S4** editor + exporters + install | ⏳ **feature-complete, QA pending** | 534 tests, 10/10 components survive a real browser, 3 exporters byte-identical, install 21.2 s |

**534 tests · 0 skipped · `hermes verify` ok=true · zero leaked containers.**

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

**Plugin containment** — a real third-party package (`notes`) installs, is capability-granted, and under `--network none` gets **`ENETUNREACH`** on TCP while still getting host answers over the socket. Undeclared op → `PL_REJECTED`; foreign table → `PL_NO_TABLE`.

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

---

## Open before S4 GO

1. **TLS is never exercised** — every harness strips 443/`ssl_*`, so a bad cert path is invisible.
2. **ACME cannot start** — `acme-companion` needs a docker-gen service not in the compose file; LE cannot validate `acme.test`.
3. **Registry pull unproven** — compose driven with locally built `skw-app:s4d` / `skw-runner:s4d`.
4. **Plugin lifecycle gaps** — no restart signal after install, no uninstall/rollback, no signature/trusted-key flags on `skwctl plugin install` (unsigned only), no audit row on a refused install, one tenant per command, copied package ownership/mode unasserted.
5. **No composed plugin invoke** — the runner is wired, but no HTTP route drives it in a composed stack.

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
