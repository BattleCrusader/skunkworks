# 01 — Verification evidence
**Produced by:** `scripts/model/build_verification.py` (a script, not a memory) · `make test` exit **0** · SDS 2089 lines / 144,674 bytes
Everything below is either captured output or a `stat()` on a file that exists. Where a claim is not executable on this box, §5 says so instead of implying a proof.

---

## 1. `make test`, verbatim
Command: `make test` (→ `verify-gitignore`, `verify-schema`, `verify-claims`, `verify-frozen`). Exit code **0**.
```
PASS  13 must-ignore + 7 must-keep = 20 paths behave as intended
control.sql: v2, 8 tables, 69 columns
site.sql:    v4, 27 tables, 229 columns
png:         docs/debate/diagrams/r1-data-model.png (183466 bytes)
png:         docs/sds/diagrams/er-data-model.png (183466 bytes)
control.db: v2, 8 tables, 8 explicit indexes, 5 FK clauses, 0 triggers, integrity=ok, fk_check=0 violations, journal=wal, app_id=0x534b5700
site.db: v3, 27 tables, 21 explicit indexes, 16 FK clauses, 5 triggers, integrity=ok, fk_check=0 violations, journal=wal, app_id=0x534b5701
   ok every trigger registered: 5 triggers == 5 registry rows

asset identity and the generated path (C-17)
   ok image asset: accepted
   ok asset key with ../: rejected (CHECK constraint failed)
   ok asset key uppercase: rejected (CHECK constraint failed)
   ok image without dimensions: rejected (CHECK constraint failed)
   ok INSERT naming the generated storage_path: rejected (cannot INSERT into generated column "storage_path")
   ok UPDATE naming the generated storage_path: rejected (cannot UPDATE generated column "storage_path")
   ok sha256 rewrite (address is immutable): rejected (SKW_E_DM_COLUMN_IMMUTABLE)
   ok generated path is derived from (sha256,mime): content/media/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png

access codes: selector + argon2, no pepper (C-6)
   ok code with neither asset nor bundle: rejected (CHECK constraint failed)
   ok code with both asset and bundle: rejected (CHECK constraint failed)
   ok selector of length 5: rejected (CHECK constraint failed)
   ok selector of length 3: rejected (CHECK constraint failed)
   ok plaintext code stored as code_hash: rejected (CHECK constraint failed)
   ok 4-char selector + argon2id PHC: accepted
   ok duplicate selector: rejected (UNIQUE constraint failed)
   ok selector rewrite is immutable: rejected (SKW_E_DM_COLUMN_IMMUTABLE)
   ok code_hash rewrite is immutable: rejected (SKW_E_DM_COLUMN_IMMUTABLE)
   ok uses bump is allowed: accepted
   ok lowering max_uses below uses (revoke-lite): accepted
   ok no pepper or lookup column: ['asset_id', 'bundle_id', 'code_hash', 'code_selector', 'created_at', 'expires_at', 'id', 'issued_to_email', 'last_used_at', 'max_uses', 'order_ref', 'revoked_at', 'uses']

redemption accounting: jti is the unit (C-7, C-14)
   ok event without bytes_declared: rejected (NOT NULL constraint failed)
   ok event with a made-up kind: rejected (CHECK constraint failed)
   ok NULL-jti denial: accepted
   ok NULL-jti denial: accepted
   ok NULL-jti denial: accepted
   ok first event: accepted
   ok range continuation under the same jti: accepted
   ok second first event for one jti: rejected (UNIQUE constraint failed)
   ok bytes_sent may be NULL (v1 never observes it): accepted

page path, template slug, body ban (O-15, C-23, C-12)
   ok root path '/': accepted
   ok page path /a/: rejected (CHECK constraint failed)
   ok page path /a/../b: rejected (CHECK constraint failed)
   ok page path /x//y: rejected (CHECK constraint failed)
   ok template 'Landing' (uppercase): rejected (CHECK constraint failed)
   ok template 'docs-v2' (a slug, not an enum): accepted
   ok body with <script: rejected (CHECK constraint failed)
   ok body with <SCRIPT (LIKE folds case): rejected (CHECK constraint failed)
   ok body with an HTML comment: rejected (CHECK constraint failed)
   ok body with javascript: URL: rejected (CHECK constraint failed)
   ok body with a list component: accepted

redirect targets stay internal (O-16)
   ok redirect to '/': accepted
   ok to_path //evil.example: rejected (CHECK constraint failed)
   ok to_path /a/../b: rejected (CHECK constraint failed)
   ok to_path /x/: rejected (CHECK constraint failed)

data sources: no function kind, aggregates are grammar (C-18)
   ok datasource kind=function: rejected (CHECK constraint failed)
   ok datasource spec is not JSON: rejected (CHECK constraint failed)
   ok aggregate_json is an array, not an object: rejected (CHECK constraint failed)
   ok aggregate count over an indexed column: accepted

runtime table classes: u_* and p_* only (C-13)
   ok u_* registered as class user: accepted
   ok p_* registered as class plugin: accepted
   ok u_* claiming class plugin: rejected (CHECK constraint failed)
   ok p_* with no plugin id: rejected (CHECK constraint failed)
   ok bare 'p_' table name (the GLOB 'p_*' off-by-one): rejected (CHECK constraint failed)
   ok a cms_* table in the runtime registry: rejected (CHECK constraint failed)

component registry is the loop contract (C-4)
   ok shipped component 'hero': accepted
   ok shipped component 'prose': accepted
   ok shipped component 'image': accepted
   ok shipped component 'gallery': accepted
   ok shipped component 'download-button': accepted
   ok shipped component 'cta': accepted
   ok shipped component 'form': accepted
   ok shipped component 'embed': accepted
   ok shipped component 'list': accepted
   ok shipped component 'page': accepted
   ok shipped component 'landing': accepted
   ok shipped component 'post': accepted
   ok shipped component 'index': accepted
   ok shipped component 'copy-email': accepted
   ok list without a repeat child: rejected (CHECK constraint failed)
   ok list with a different child selector: rejected (CHECK constraint failed)
   ok non-list with a repeat child: rejected (CHECK constraint failed)
   ok limit_max out of range: rejected (CHECK constraint failed)

plugin trust and settings (C-9, O-44)
   ok enabled plugin with no test report (O-37): rejected (CHECK constraint failed)
   ok installed plugin with a test report: accepted
   ok secret setting not flagged secret: rejected (CHECK constraint failed)
   ok secret setting: accepted
   ok setting for an uninstalled plugin: rejected (CHECK constraint failed)

audit is append-only (C-21)
   ok audit insert: accepted
   ok audit update: rejected (SKW_E_DM_COLUMN_IMMUTABLE)
   ok audit delete: rejected (SKW_E_DM_COLUMN_IMMUTABLE)

asset delete guard (O-04)
   ok delete a linked asset with fk=OFF: rejected (SKW_E_DM_ASSET_IN_USE)
   ok delete after unlinking: accepted

error codes are one taxonomy (C-19)
   ok 67 codes, all match ^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$
   ok every SKW_E_ code raised by the DDL is registered (2 distinct: ['SKW_E_DM_ASSET_IN_USE', 'SKW_E_DM_COLUMN_IMMUTABLE'])
control.db empty size after VACUUM: 110592 bytes
site.db empty size after VACUUM: 319488 bytes

FAILURES: none
PASS  1 schema/ER parity + negative tests                      v3: 35 entities == 35 CREATE TABLE; r1-data-model.png 183466 B; er-data-model.png 183466 B
PASS  2 cp loses data, VACUUM INTO keeps it                    cp=no such table; VACUUM INTO rows=1000 user_version=9 views=1 jm=delete wal_before=28872B
PASS  3 key immutable by FK, not by app                        referenced rename REJECTED, unreferenced rename ACCEPTED
PASS  4 partial unique index breaks FK parent                  foreign key mismatch - "u_p" referencing "cms_asset"
PASS  5 sqlite_sequence survives restore, not rebuild          seq 5->3 across rebuild; restored -> next id 6
PASS  6 PRAGMA foreign_keys is a no-op in a txn                inside txn=1, after commit=1 (silently ignored)
PASS  7 argon2id equality lookup is impossible                 verify=70.2ms, salted (different hashes) -> 5000-code scan=351s; hmac=1.785ms
PASS  8 readonly is not a tenancy boundary                     readonly handle read 1 foreign row(s): buyer@acme.com
PASS  9  r2 amendments apply to a populated v1                 user_version 2, integrity ok, fk_check 0, revisions=2, seq cms_page=3, 3 triggers all registered
PASS  10 root path '/' is insertable                           v1 REJECTED '/' (homepage uninsertable) and ACCEPTED to_path='//evil.example'; amended accepts '/', rejects '/a/', '/../x', '/x//y' and '//evil.example', '/a/../b', '/x/'
PASS  11 storage_path is generated, sha256 immutable           cannot INSERT into generated column "storage_path"; cannot UPDATE generated column "storage_path"; sha256 -> SKW_E_DM_COLUMN_IMMUTABLE
PASS  12 asset delete guard holds with foreign_keys=OFF        fk=0 python -> SKW_E_DM_ASSET_IN_USE; cli rc=19 -> Error: stepping, SKW_E_DM_ASSET_IN_USE (19); unreferenced delete OK with fk=1, derived rows cascaded {'cms_asset_variant': 0, 'cms_asset_alias': 0, 'cms_watermark_render': 0}
PASS  13 rebuild with fk=ON cascade-deletes children           revisions before=2; DROP with fk=ON -> 0 (cascade deleted); rebuild with fk=OFF -> 2
PASS  14 dedupe write order: 24 requests, 1 download           24 concurrent requests, one jti: update-first uses=24 (events=1); insert-first uses=1 (events=1)
PASS  15 (jti) WHERE kind='first' tolerates NULL               3 NULL-jti denials accepted; (J1,'first') twice -> UNIQUE constraint failed: cms_download_event.jti; (J1,'range') accepted; null=4
PASS  16 export projection is the reproducible unit            27/27 tables classified {'filtered': 2, 'rows': 18, 'empty': 7}; vac==vac 803efbcd9aac; after volatile rows file 8294f0e619df (differs) but projection ccfaba20d374 (identical); content change -> 517be2483625 (differs)
PASS  17 argon2 parameter cost on this box                     m=19456,t=2,p=1 min=23.3 med=24.1ms; m=65536,t=3,p=1 min=128.7 med=171.5ms (7.1x)
PASS  18 an unanchored audit chain proves nothing              tamper row 2 + recompute chain -> unanchored chain verifies (True); anchored head mismatches (7885b109.. -> c57f64d3..)
PASS  19 delete-guard cost, indexed vs not                     200k referencing rows, unreferenced delete: no index 7.92 ms, indexed 0.023 ms (n=5 each)
PASS  20 migration chain v1->v4 converges on site.sql          27 tables / 5 triggers identical on both paths; user_version 4 (E-31 item 5: activation_seq); codes-in-file -> REJECTED (legacy_12_char_codes_have_no_v3_selector)
PASS  21 selector seek + argon2 verifier (C-6)                 5000 issued, 8 selector collisions resolved by retry; seek p50=5.42us (plan SEARCH, 1000 lookups); argon2 m=19456,t=2 real=24.7ms dummy=24.5ms; duplicate -> UNIQUE constraint failed: cms_download_code.code_selector
PASS  22 redemption on the v3 tables (C-7)                     24 concurrent threads, one jti -> uses=1, first rows=1; cap 2 reached -> J3 outcome=denied_quota uses=2 (0 rows updated); Range row writes=1, uses=2
PASS  23 export projection is a union over the live DB (C-5)   29/29 live tables classified (core 27, u_ 1, p_ 1); modes used=['empty', 'filtered', 'rows']; manifest without export -> SKW_E_PL_NO_EXPORT_CLASS for ['p_contact_message']
PASS  24 plugin table class + asset guard (C-13/O-36)          guard -> SKW_E_DM_ASSET_IN_USE; without it the delete leaves 1 dangling asset_key (registered guard rows before drop=1)
PASS  25 audit chain needs a daily seal (C-21)                 10000 rows chained 60.9ms, verified 39.3ms, sealed 65us; tail deleted -> chain verifies (True) but seal says rows=10000 head=41f67e7d.. vs 9995/a77a75bf.. -> SKW_E_SEC_AUDIT_SEAL
PASS  26 body ban + list loop contract (C-12/C-4)              DB rejected 5 body vectors (script element, style element, html comment, javascript: url, srcdoc); loop: deterministic, text escaped, [data-empty] on zero rows, clamp 99->50 with data-truncated; unknown shell 'docs-v2' -> SKW_E_RT_TEMPLATE_UNKNOWN (4 shells shipped)
PASS  27 connection classes: query_only is not tenancy (C-15)  query_only: VACUUM INTO -> attempt to write a readonly database; temp trigger -> attempt to write a readonly database; ATTACH -> ALLOWED: main,temp,other; exporter class wrote 8192 B

27/27 passed, 0 skipped, 0 failed
adopted sentences: 25/25 verbatim in SDS.md
frozen §4 blocks: 12/12 verbatim
resolution steps: 5/5 present; env names: 29/29 present

PASS the SDS quotes the register
```

### 1.1 What the run proves, in one line each
- `.gitignore`: 13 must-ignore + 7 must-keep = 20 verdicts correct.
- `control.db` at v2: 8 tables, 8 indexes, 5 FK clauses, integrity ok, 0 FK violations.
- `site.db` at v3: 27 tables, 21 indexes, 16 FK clauses, 5 triggers — every one registered in `cms_trigger_registry`.
- `verify_claims.py`: **27/27 passed**, 0 skipped, 0 failed.
- ER ↔ DDL parity: **35 entities == 35 CREATE TABLE** in both `.puml` files, both PNGs rendered.
- SDS ↔ register fidelity: **PASS** — every adopted sentence, every frozen §4 block, every env name and every resolution step is present verbatim.

---

## 2. ER ↔ DDL parity

| Quantity | Value |
|---|---|
| Entities in `er-data-model.puml` == `CREATE TABLE` in both `.sql` files | 35 |
| `site.sql` (v4) | 27 tables, 229 columns |
| `control.sql` (v2) | 8 tables, 69 columns |
| Parity mechanism | one spec (`scripts/model/gen_schema.py`) emits both DDL files and both `.puml` files; check 1 compares the entity set against the `CREATE TABLE` set and fails on any difference |
| Column-level parity | same spec, so a column cannot exist in one artefact only; the migration chain is separately proved to converge on the target (check 20) |

---

## 3. Diagrams

7 PlantUML sources, 7 rendered PNGs in `docs/sds/diagrams/`, plus the regenerated debate ER. A PNG under 5 KB would be a PlantUML error card; none is.

| Diagram | Source | PNG bytes | Dimensions |
|---|---|---|---|
| `backup-restore` | `docs/sds/diagrams/backup-restore.puml` | 82,275 | 942×1842 |
| `components` | `docs/sds/diagrams/components.puml` | 143,141 | 2882×918 |
| `er-data-model` | `docs/sds/diagrams/er-data-model.puml` | 183,466 | 3723×1660 |
| `export-pipeline` | `docs/sds/diagrams/export-pipeline.puml` | 96,349 | 1195×2014 |
| `gated-download` | `docs/sds/diagrams/gated-download.puml` | 156,868 | 1300×3686 |
| `plugin-install` | `docs/sds/diagrams/plugin-install.puml` | 117,710 | 888×3168 |
| `request-lifecycle` | `docs/sds/diagrams/request-lifecycle.puml` | 100,894 | 775×2611 |
| `r1-data-model` | `docs/debate/diagrams/r1-data-model.puml` | 183,466 | 3723×1660 |

Smallest PNG: 82,275 B. Largest: 183,466 B. Every source has a PNG and every PNG has a source.

---

## 4. Traceability coverage

| Set | Count | Mapped in SDS | Proved by `make test` today | Deferred with an experiment |
|---|---|---|---|---|
| Conflicts `C-1…C-25` | 25 | 25 | 15 | 0 |
| Objections `O-1…O-44` | 44 | 44 | 10 | 4 (O-27, O-39, O-40, O-43) |
| **Total** | **69** | **69** | **25** | **4** |

**Coverage: 69/69 register entries mapped to a section that implements them (100 %).** Of those, 25 carry an executable proof in this repository; the other 44 carry a named slice gate (S1–S5) in SDS §16, because a SQL engine cannot prove a CSP header, an ACME issuance or a cookie rule.

Parsed from SDS §17: **25 conflict rows + 44 objection rows = 69 entries**; 25 proved by `make test`, 44 by a slice gate, 4 deferred with an experiment.

| ID | Verdict | Implemented in | Proved by |
|---|---|---|---|
| C-1 | B's mechanism, A's status rule rejected for the empty case | §5.1, §5.2, §5.3 | S1 (10 cases) |
| C-2 | nginx strips, the app emits | §5.5, §12.3 | S1 (prefix incl. POST) |
| C-3 | `ON UPDATE RESTRICT` + bounded `repoint` | §7.1, §4.1 | MT check 3; S3 (cap + audit row) |
| C-4 | the `list` component, not a block table, not an island | §6.3, §4.1 | MT check 26; S4 fixpoint |
| C-5 | projection is a union over the live DB | §11.2, §4.1 | MT check 23 |
| C-6 | selector + argon2, 16 chars, `m=19456,t=2,p=1`, semaphore 4 | §7.2, §4.5 | MT checks 21, 7, 17 |
| C-7 | the redemption (`jti`) is the unit, insert-first | §7.3 | MT checks 14, 22 |
| C-8 | a fourth service, 48 MB once | §8.4, §12.1 | S4 (compose + runner probe) |
| C-9 | no publisher CA (D27) | §8.5 | S4 (signature matrix) |
| C-10 | split boot gate by plane | §12.4, §2.3 | S1 (migration report) |
| C-11 | `/admin/t/<key>/…`, session only | §9.2 | S2 (resolver test) |
| C-12 | `script-src 'self'`, islands emitted by the renderer | §10.5 | MT check 26; S4 (CSP equality) |
| C-13 | the seven-op AST, FK target from the type | §4.4, §4.1 | MT (validate negatives); S2 corpus |
| C-14 | `bytes_declared` vs `bytes_sent` | §7.4, §4.1 | MT check 15; S3 (log ingest) |
| C-15 | three connection classes | §2.2 | MT check 27 |
| C-16 | fail closed, bounded transient, encrypted refused at issue | §7.5 | S3 (timeout, issue refusal) |
| C-17 | one byte tree, `storage_path` generated | §7.1 | MT checks 11, 12; S4 (link absence) |
| C-18 | `function` removed, aggregates as grammar | §6.1, §6.2 | MT (validate kind); S2 (publish gate) |
| C-19 | one prefix, one taxonomy, one name per concept | §4.3 | MT (taxonomy scan); S1 (boot guard) |
| C-20 | derived rate limit, 50 hot tenants per box | §12.3 | S1 (nginx_gen) + release gate |
| C-21 | split audit + daily seal | §9.6, §4.1 | MT check 25 |
| C-22 | enumerate, cap, refuse, pin the clock | §6.4, §11.3, §11.4 | MT check 16; S4 (reproducibility) |
| C-23 | `template` is a slug against the shell registry | §10.4, §4.1 | MT check 26; S2 (publish refusal) |
| C-24 | a seed, never the fleet file | §11.6, §4.1 | S4 (install + content assertion) |
| C-25 | demo host ≠ admin host | §5.6, §12.3 | S1 (listener/Host test) |
| O-01 | REJECTED as a v1 defect | §5.5 (recorded CDN constraint) | recorded, no gate (v1 has no CDN) |
| O-02 | ACCEPTED | §6.1, §12.2 (`content/sources/` never shipped) | S4 (bundle listing) |
| O-03 | ACCEPTED | §12.2 (rw volumes, ro root fs) | S1 (compose assertion) |
| O-04 | ACCEPTED | §4.1, §9.3 (triggers + registry) | MT checks 12, 24 |
| O-05 | ACCEPTED | §4.5 (`foreign_keys=OFF` outside the txn) | MT check 13 |
| O-06 | ACCEPTED | §4.5 (`sqlite_sequence` carry-forward) | MT check 5 |
| O-07 | ACCEPTED | §7.4 (`filename*=UTF-8''…`) | S3 (`报告.pdf`) |
| O-08 | ACCEPTED | §7.5, §11.5 (wm excluded, class `pii`) | S4 (bundle grep) |
| O-09 | ACCEPTED | §11.6 (relative links, regex check) | S4 (`bundle_verify`) |
| O-10 | ACCEPTED | §6.2 (cache key includes params) | S2 (both orders) |
| O-11 | ACCEPTED | §3 (`addContentTypeParser`, mount seam) | S1 (1 MiB JSON POST) |
| O-12 | ACCEPTED | §15.3 (5 ms loop budget, off-loop worker) | S3 (forced stall test) |
| O-13 | ACCEPTED | §10.6 (`managed_by`) | S4 (read-only open) |
| O-14 | ACCEPTED | §6.2 (`cost_ms_max`, plan before measure) | S2 (publish gate) |
| O-15 | ACCEPTED | §4.2 (path predicate) | MT check 10 |
| O-16 | ACCEPTED | §4.2 (`to_path` internal-only) | MT check 10 |
| O-17 | ACCEPTED | §6 (`site.page(path)`) | S2 (nested-path test) |
| O-18 | ACCEPTED | §2.2, §11.4 (`VACUUM INTO` on `exporter`) | MT checks 2, 27 |
| O-19 | ACCEPTED | §11.4 (producer-side counts) | S4 (two fixtures) |
| O-20 | ACCEPTED | §11.2, §11.5 (`empty`, `pii`, `secret` classes) | MT check 16; S4 |
| O-21 | ACCEPTED | §11.6 (`readlink` + regex, `find -L` banned) | S4 (`bundle_verify`) |
| O-22 | ACCEPTED | §11.6 (ship cold, verify `immutable=1`) | S4 (verifier) |
| O-23 | ACCEPTED | §1.2, §11.6 (bracketed promise) | S4 (measured install) |
| O-24 | ACCEPTED | §11.1 (lockfile + CI build) | S4 (`npm ci && build`) |
| O-25 | ACCEPTED | §12.3 (generated blocks, no nginx-proxy) | S1 (nginx_gen) |
| O-26 | ACCEPTED | §9.5 (three endpoints) | S1 (health tests) |
| O-27 | **DEFERRED** | §18.1 | S5 experiment |
| O-28 | ACCEPTED | §7.6 (SMTP, `off`, reissue) | S3 (webhook 201 body) |
| O-29 | ACCEPTED | §3, S2 (preview token) | S2 (preview test) |
| O-30 | ACCEPTED | §8.6 (core intake = plugin contract) | S2 (spam cases) |
| O-31 | ACCEPTED | §14 (expiry cascade) | S4 (expiry test) |
| O-32 | ACCEPTED | §5.4 (own `site.db` per demo) | S1 (demo provisioning) |
| O-33 | ACCEPTED | §9.1 (`SKW_FLEET_MODE=0`) | S2 (role refusal) |
| O-34 | ACCEPTED | §4.1 (`cms_download_code_archive`) | schema; S3 (prune test) |
| O-35 | ACCEPTED | §4.1 (`cms_plugin_*`, `p_` exclusive) | MT validate (`p_` grammar) |
| O-36 | ACCEPTED | §8.2 (guard per `asset_key` column) | MT check 24 |
| O-37 | ACCEPTED | §8.5 (test report + digest) | S4 (install matrix) |
| O-38 | ACCEPTED as a limitation | §8.4, §13.3, §10.2 | stated on the install screen |
| O-39 | **DEFERRED** | §18.2 | S5 experiment |
| O-40 | **DEFERRED** | §18.3 | S5 experiment |
| O-41 | ACCEPTED | §8.5 (bundles ship plugins, local revocation) | S4 |
| O-42 | ACCEPTED | §6.1, §11 (only via a `query` source) | S4 (static export test) |
| O-43 | **DEFERRED** | §18.4 | S5 experiment |
| O-44 | ACCEPTED | §8.1, §11.2 (`cms_plugin_setting`, `secret = 0`) | MT check 23; S4 |

---

## 5. What this file does not prove

1. **The browser half of three controls** (`__Host-` rejection, CSRF-token theft, island-props breakout). No
   browser exists on this box; the server-side contract of each is tested, the UA behaviour is a CI Chromium
   test in S3/S4.
2. **ACME against a production CA.** The 16.01 s figure in the register came from Pebble with validation
   short-circuited.
3. **The composed plugin path across two containers.** Socket hop and child IPC are measured separately;
   their sum is arithmetic.
4. **A 1 GiB bundle transfer.** 6.8 min at 20 Mbps is arithmetic over a measured bundle size.
5. **A real page render under load.** The 192 r/s figure is the corpus's measurement; this repository has no
   HTTP server, so no page throughput is claimed here.
6. **That the SDS is complete.** It is complete *against the register*: 69/69 entries mapped, 25/25 frozen
   sentences verbatim, every env name and resolution step present. Whether the register itself is complete is
   Phase A's claim, checked there, not here.

---

*Regenerate with `python3 scripts/model/build_verification.py`. The file is derived, so a stale number is a bug in the script, not a matter of opinion.*
