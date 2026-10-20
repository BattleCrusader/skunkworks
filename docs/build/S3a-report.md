# S3a — content-addressed storage, upload hardening, asset rows, the link graph, and D6

**Slice:** S3a (first half of §16 S3 — assets only; the download plane is S3b).
**Tree:** `d77a8c3` + the working tree below. **Not committed** (the brief's rule).
**Gate:** `make test` → **333 tests, 333 pass, 0 fail, 0 skipped, RC=0** (was 306; +27 new).
`make test-perf` → 4/4, RC=0. No timing assertion was added to `test/`.

This report is written to be checked, not believed: every claim below is followed by the command that
produced it and the output that command printed.

---

## 1. What this slice is, and what it is not

S3a is the **byte and row layer** of §7.1: a checksum-addressed store that cannot be made to overwrite
itself, an upload path that decides the type from the bytes, `cms_asset` rows whose identity is the key
(D17), and the link graph that makes "can I delete this?" a fact. It ends at the database. Nothing in
this slice serves a byte over HTTP, and that is deliberate: the public symlink farm (D18) is S3b, and a
farm without a store is a link to nothing.

D6 is carried in front of it because it blocks public pages: an out-of-band column drop currently
surfaces as a raw `SQLITE_ERROR` and therefore a `500` on a public render.

## 2. The scope, item by item

| # | Item | Where it lives | State |
|---|---|---|---|
| 0 | D6 — drift becomes a taxonomy refusal, no 500, no stack | `app/sources/registry.ts` (`allowlistFor` + drift log), `app/sources/compile.ts` (`column_drift`), `app/sources/resolve.ts` (`mapSourceSqliteError` + the guarded execute) | done, 6 gates |
| 1 | Content-addressed storage: `content/media/<sha[0:2]>/<sha>.<ext>`, dedupe, immutability, quota before the write, checksum over the stored bytes | `app/assets/store.ts` | done, 5 gates |
| 2 | Upload hardening: magic bytes, `sharp` re-encode (EXIF/GPS out), SVG refused, cap, filename never a path, no executable path | `app/assets/sniff.ts` (+ `store.ts`'s closed extension set) | done, 7 gates |
| 3 | `cms_asset` rows: key identity, key uniqueness, alias on rename, the DDL's FK behaviour | `app/assets/library.ts` | done, 6 gates |
| 4 | The link graph: rows on a page/datasource reference, delete refused while linked | `app/assets/links.ts` | done, 3 gates |

Files created: `app/assets/sniff.ts`, `app/assets/store.ts`, `app/assets/library.ts`,
`app/assets/links.ts`, `test/assets.test.ts`, `test/d6-error-surface.test.ts`,
`scratch/s3a/proofs.ts`, `scratch/s3a/exif-probe*.mjs`.
Files modified: `app/errors.ts` (one code, already in the frozen registry), `app/sources/registry.ts`,
`app/sources/compile.ts`, `app/sources/resolve.ts`, `package.json` + `package-lock.json` (`sharp`).
Not mine, and untouched: `docs/sds/02-errata.md` carries 257 added lines this slice did not write (a §11
E-24/E-25 amendment that landed in the tree while it ran — Architect's work, not S3a's).

---

## 3. The acceptance criteria: command, output

The full pair of files:

```
$ node --test --test-concurrency=1 test/assets.test.ts test/d6-error-surface.test.ts
...
# tests 27
# pass 27
# fail 0
```

Each criterion is also runnable alone. The commands below are the ones that produced the output under
them — `--test-name-pattern` filters to the named suite, and every suite is self-contained (none depends
on a row another suite wrote; that was a defect in the first draft of this file and is fixed).

### C1 — the same bytes twice produce ONE file, and the answer is an explicit reuse

```
$ node --test --test-concurrency=1 --test-name-pattern="A1" test/assets.test.ts
ok 1 - A1 — the same bytes twice produce one file
# pass 1
# fail 0
```

```
$ node scratch/s3a/proofs.ts            # §P4 of the proof script
  1st upload            reused=false wroteFile=true id=2
  2nd (same key, bytes) reused=true wroteFile=false id=2
  3rd (new key, bytes)  reused=false wroteFile=false id=3 same sha=true
  blobs for that sha    1
  sqlite ledger         422 B  disk 422 B
```

**Which of the two the code chooses, and why.** Both, at different levels, because D13 and D17 answer
different questions. **Same key + same bytes → one row and an explicit `reused: true`** (the caller is
told the upload was a dedupe, not a write: a silent no-op is indistinguishable from success). **Same
bytes + a different key → a new row over the same blob** (D17: identity is the key; `banner-home` and
`banner-footer` are two assets that happen to share bytes, and collapsing them would make one key's
rename or delete silently change the other's URL). The invariant is the file: **one blob, always**.

### C2 — GPS EXIF comes out, asserted on the bytes

```
$ node --test --test-concurrency=1 --test-name-pattern="A3" test/assets.test.ts
ok 1 - A3 — an image with GPS EXIF comes out without it
# pass 1
# fail 0
```

The proof in full is §4.1 below. Short form: 134 B of APP1 EXIF with a real GPS IFD in, 327 B of JPEG
with **no** `Exif\0\0`, `metadata.exif === undefined`, and byte-identical to the encode of the same
pixels without EXIF.

### C3 — a PHP/HTML payload renamed `.png` is refused, and nothing is written

```
$ node --test --test-concurrency=1 --test-name-pattern="A4" test/assets.test.ts
ok 1 - magic-byte sniff refuses it, and the content tree is untouched
ok 2 - an HTML document renamed .png is refused by the same rule
# pass 2
# fail 0
```

```
$ node scratch/s3a/proofs.ts            # §P2
  refused               SKW_E_SEC_UPLOAD_REJECTED (415) reason=magic_mismatch claimed=image/png sniffed=null
  store before          1 file(s)
  store after           1 file(s)
  byte-identical        true
  cms_asset rows        1 (the refused upload wrote none)
```

The order is the proof: `sniffAndNormalise` throws before `putBytes` is called, and `putBytes` is the
only function that touches the filesystem. The tree is compared as `path:size:sha256` before and after,
so "nothing was written" also means "no temp file was left".

### C4 — an SVG is refused with its code

```
$ node --test --test-concurrency=1 --test-name-pattern="A5" test/assets.test.ts
ok 1 - an .svg upload is 415 SKW_E_SEC_UPLOAD_REJECTED, reason svg_forbidden
ok 2 - an SVG payload named .png is refused too (extension is not the rule)
# pass 2
# fail 0
```

`415 SKW_E_SEC_UPLOAD_REJECTED`, `reason='svg_forbidden'`. Both the extension (`.svg`) and the first
non-whitespace bytes (`<svg`, or `<?xml … <svg`) are checked, because renaming an SVG to `.png` is the
obvious next attempt and the magic-byte table would see nothing it recognises.

### C5 — the quota is enforced BEFORE the write; the store stays byte-identical

```
$ node --test --test-concurrency=1 --test-name-pattern="A6" test/assets.test.ts
ok 1 - 1 byte of headroom, a 2-byte write: refused, and the store is byte-identical
ok 2 - an upload over quota leaves no file, no row, and no temp file
ok 3 - the limit is the tenant’s own storage_quota_bytes, not a constant
ok 4 - a deduplicated upload is allowed at exactly the quota: it costs no bytes
# pass 4
# fail 0
```

```
$ node scratch/s3a/proofs.ts            # §P3 — literally the criterion's numbers
  store                 ["media/8f/8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4.bin"]
  refused               SKW_E_DM_QUOTA (507) limit=3 used=2 needed=2
  store byte-identical  true
```

`putBytes` reads `exists → quota → mkdir → write`, so with 1 byte of headroom the 2-byte write is refused
before the directory is even created. A check after `writeFile` would be a report, not a limit — the
bytes are already on the tenant's disk when it fires. The limit comes from
`control.db.tenant.storage_quota_bytes` via `storageQuotaFor(controlDb, tenantKey)`; the default is
1 GiB and a lowered value is honoured (§C5 `ok 3`). A deduplicated upload needs zero bytes and is
therefore allowed at exactly the quota — the third test proves the quota does not become a false
refusal for the operation D13 exists to make free.

### C6 — immutability, and the rename that writes an alias

```
$ node --test --test-concurrency=1 --test-name-pattern="A7" test/assets.test.ts
ok 1 - re-uploading different bytes under an existing key is refused
ok 2 - the same bytes under a new key while a store file exists does not overwrite it
# pass 2
# fail 0
```

`409 SKW_E_DM_COLUMN_IMMUTABLE` — the same code the schema's `trg_cms_asset_sha_immutable` raises, so the
app refuses first and the trigger is the backstop for every other writer. The row is compared before and
after (`{id, sha256, bytes}` deep-equal) and the tree is compared too, so "refused" cannot mean "refused
after writing".

```
$ node --test --test-concurrency=1 --test-name-pattern="A8" test/assets.test.ts
ok 1 - an unreferenced rename writes the alias row and moves no bytes
ok 2 - a link refuses the rename, and the delete names the code until it is unlinked
ok 3 - the alias cascades when the asset is deleted
ok 4 - a page reference writes the link row when the page is scanned
# pass 4
# fail 0
```

### C7 — delete with a link is refused, then succeeds, and the alias cascades

Same command as C6 (`A8`), tests 2 and 3:

- `409 SKW_E_DM_ASSET_IN_USE`, `detail.references = 1`;
- **and the same refusal from a raw `DELETE FROM cms_asset`** (`assert.throws(… /SKW_E_DM_ASSET_IN_USE/)`),
  so the trigger — not the app's pre-check — is what a `sqlite3` CLI meets;
- after `unlinkAsset`, `deleteAsset` returns `{deleted:true}` and `cms_asset_alias` has 0 rows for that
  asset, which is `ON DELETE CASCADE` doing what the DDL says.

A rename of a **linked** key is `409 SKW_E_DM_KEY_IN_USE` with the reference count, per §7.1 — not a
cascade. The `repoint` operation that rewrites up to `SKW_REPOINT_MAX_ROWS` references is S3b; it is
deliberately not reachable from `renameAsset`.

### C8 — D6: forced drift yields a taxonomy code and zero stack frames

```
$ node --test --test-concurrency=1 test/d6-error-surface.test.ts
ok 1 - D6-0. the control resolves before any drift
ok 2 - D6-1. an out-of-band column drop refuses with the taxonomy code, naming the column
ok 3 - D6-2. a source that does not name the drifted column still resolves
ok 4 - D6-3. the refusal logs one line that names the drifted column
ok 5 - D6-4. a real SQLite error from the resolve statement is mapped, not rethrown
ok 6 - D6-5. on the wire: 422, a taxonomy body, and no stack, path or SQL text
# tests 6
# pass 6
# fail 0
```

What changed, in the order the defect is met:

1. **`allowlistFor` for a `query` source is now the intersection** of `cms_table_registry.columns_json`
   and the live `PRAGMA table_xinfo`, and the difference is kept as `drifted`. Before, the registry and
   the database could agree with each other and still disagree about a column that no longer exists —
   which is exactly the state QA reproduced (`code=SQLITE_ERROR … no such column: "slug"`).
2. **The refusal names the cause.** `422 SKW_E_RT_SOURCE_UNKNOWN`, `reason='column_drift'`,
   `detail.column='slug'`, `detail.relation='u_posts'` — the code §6.2's own table row assigns to
   "every referenced column exists in the relation's allowlist".
3. **Drift is logged where it is observed**, not only where a source names the column:
   `column_drift tenant=acme relation=u_posts column=slug`, rate-limited per
   (tenant, relation, column) per 60 s. `D6-2` is the control that this is not over-refusal: a source
   that does not name the dropped column still returns its three rows.
4. **The catch-all maps the TOCTOU window.** The allowlist and the statement are two reads of a schema
   anything with a file handle may change in between; `mapSourceSqliteError` turns a real SQLite error
   from the prepare/execute into the same code (`D6-4` uses a genuine `better-sqlite3` error, not a
   fake). `SQLITE_BUSY/LOCKED` → `503 SKW_E_DM_BUSY`; a corrupt/unreadable file →
   `503 SKW_E_PLT_TENANT_UNAVAILABLE`; any other `SQLITE_*` → `SOURCE_UNKNOWN/SQLITE_ERROR` with the
   SQLite code in `detail` and **never** the statement.
5. **On the wire** (`D6-5`, through the app's real `setErrorHandler`/`sendError`): status **422**, a
   taxonomy-shaped body, and seven negative assertions on the raw text — no `\n at `, no `node_modules`,
   no `.ts:`, no `SQLITE_ERROR`, no `no such column`, no `SELECT |INSERT |PRAGMA `, no absolute path.

**Honest note on the wire test:** v1 has no product route that resolves a source (the `list` component,
the first consumer, is S4 — the same gap the S2 errata declined as "not a defect"). So the gate
registers the route itself on the real app instance; everything the assertion is about — the error
handler, `sendError`, the render-read connection class, the resolver — is the app's.

---

## 4. The two byte proofs, in full

### 4.1 EXIF including GPS: in, then out

```
$ node scratch/s3a/proofs.ts
=== P1. EXIF with GPS: in, then out ===
  upload bytes          414 B  sha256=95de82534aead5b0…
  upload has 'Exif\0\0' true
  upload metadata.exif  134 B
  upload GPS IFD        4 tags [0x0001, 0x0002, 0x0003, 0x0004] GPSLatitude=33/1 51/1 0/1
  stored path           content/media/cc/cc9101ef530608df21a31407477534449d47d1377094243335598655498c9a07.jpg
  stored bytes          327 B  sha256=cc9101ef530608df21a31407477534449d47d1377094243335598655498c9a07
  stored has 'Exif\0\0' false
  stored metadata.exif  undefined
  stored GPS IFD        none
  row.sha256 == sha256(stored)  true
  row.storage_path == generated  true
```

Three independent readings of the same fact, because "the API says so" is not a proof:

1. **The bytes.** `Exif\0\0` is present in the upload and absent from the stored file.
2. **The parser.** libvips reads 134 B of EXIF from the upload, resolves IFD0 → GPS IFD (tag `0x8825`)
   → four GPS tags with `GPSLatitude=33/1 51/1 0/1`, and reads **undefined** from the stored file.
3. **The identity of encodings.** Re-encoding the GPS original and the plain original produce the same
   327 bytes (`sha256` equal in `A3`'s third assertion), so nothing of the EXIF block survived anywhere
   in the pipeline — not in a comment, not in a thumbnail, not in an ICC slot.

**How the fixture was made, and why by hand.** `sharp(…).withMetadata({exif:{GPS:…}})` in this libvips
build writes the tags under the *Exif* IFD and drops the GPS pointer (`scratch/s3a/exif-probe2.mjs`
prints IFD0 = `0x112,0x11a,0x11b,0x128,0x213,0x8298,0x8769` — no `0x8825`). A fixture made that way
would have proved nothing about GPS. The segment is therefore built byte by byte (big-endian TIFF, IFD0
→ GPS IFD → four tags → three rationals each) and spliced after SOI; the test *parses it back* first
(`gpsTags(meta.exif)` must equal `[0x0001,0x0002,0x0003,0x0004]`) so a broken fixture fails loudly
instead of passing vacuously.

The mechanism: every image is re-encoded through libvips, and nothing calls `withMetadata()`. There is no
"stripper" to bypass — the stored bytes are the encoder's output.

### 4.2 The magic byte, not the extension

```
$ node scratch/s3a/proofs.ts
=== P2. a PHP payload renamed .png ===
  refused               SKW_E_SEC_UPLOAD_REJECTED (415) reason=magic_mismatch claimed=image/png sniffed=null
  store before          1 file(s)
  store after           1 file(s)
  byte-identical        true
  cms_asset rows        1 (the refused upload wrote none)
```

`<?php system($_GET["c"]); ?>` sniffs to nothing; the name claims `image/png`; the two disagree, so the
upload is refused with `415` and `reason='magic_mismatch'` naming both sides (`claimed`, `sniffed`). An
HTML document gets the same answer. The accepted set is exactly the eight types the DDL's generated
`storage_path` knows (`webp, jpg, png, avif, pdf, mp4, mp3, zip`); a ninth is refused rather than stored
as `.bin` and served as octet-stream — a type the schema cannot name is a type this slice will not
mislable.

---

## 5. Decisions, and the reasoning that made them

1. **The checksum is over the stored bytes, not the upload.** An image is re-encoded, so the upload's
   hash addresses bytes that will never exist on disk. `sha256OfStored(sniffed.bytes)` is the only hash
   used, and `A6`/`path-check` assert `sha256(file on disk) === row.sha256` and
   `row.storage_path === mediaRelPath(row.sha256, 'png')`. Consequence to state plainly: **the checksum
   the client computed is not the checksum stored**, for images. That is correct for a content- addressed
   store and it is why the response returns the row rather than the client's hash.
2. **The quota counts distinct checksums, not rows.** Two keys over one blob are one blob of disk;
   `SUM(bytes)` over rows would charge a tenant twice for the dedupe the design exists to provide.
   `usedBytes` is `SUM(bytes)` over `SELECT DISTINCT sha256`, and `A2` asserts the ledger equals the sum
   of the file sizes actually in the tree.
3. **`422 SKW_E_RT_SOURCE_UNKNOWN` for drift, not a new code and not `503 SCHEMA_STALE`.** §6.2's table
   already assigns that code to "every referenced column exists in the relation's allowlist" failing at
   render, and a drifted column fails exactly that rule. `SKW_E_DM_SCHEMA_STALE` is the code for
   `user_version < tenant.db_version` (F16), which is a different fact — the file is behind the app, not
   the table behind the source. **Open for the Architect:** if a 422 on a public page is judged the wrong
   status for an infrastructure fault, the change is one line in `compile.ts`'s `check()` and one in
   `mapSourceSqliteError`; no new code would be needed either way, because the taxonomy has no better
   fit than the two named here.
4. **A filename that is a path is refused, not sanitised.** `../../etc/passwd.png` →
   `415 SKW_E_SEC_UPLOAD_REJECTED`, `reason='filename_invalid'`. Sanitising produces a *different* name
   silently, and the display name is the one string an uploader fully controls. Separately, the stored
   path cannot contain a filename at all: it is `media/<hh>/<sha>.<ext>` with `sha` verified against
   `^[0-9a-f]{64}$` and `ext` against a closed set of nine tokens.
5. **The stored file cannot be in an executable path or the module graph.** Three structural facts, one
   assertion: the extension is one of the nine the DDL emits (never `.js/.mjs/.cjs/.ts/.php/.html/.css/
   .so/.sh`); the name is a checksum, so there is no name to collide with a module specifier; and the
   content root is `/srv/content`, a sibling of `/srv/data` and outside the image's `/srv/app` (where
   `dist/` and `build/` live). The gate asserts the first directly on a real row.
6. **Two owner kinds are written, two are not.** `page` (scanned from `/media/<key>.<ext>` in
   `body_html` — the "URL-level reference no foreign key can see" that §7.1 names) and `datasource`
   (distinct values of a `u_*` column whose DDL type is `ASSET`, read from `cms_table_registry`).
   `settings` and `bundle` are legal in the schema and are not written here: settings come from the CRUD
   path and bundles from the bundle editor, and inventing a scan for either would be a link row nobody
   asked for.
7. **`sharp` is a runtime dependency now.** It is the re-encoder, so it is in `dependencies`, not
   `devDependencies`. `Dockerfile.app` runs `npm ci --omit=dev` in the runtime stage, which will fetch
   the linux-x64 prebuilt; **the image was not rebuilt in this slice** (see §6).

---

## 6. Known limits, stated rather than implied

- **No HTTP upload route.** S3a is a library: `uploadAsset` has no caller in `app/` yet. The admin
  upload screen is S3b, and until it exists the quota's only source is the helper
  `storageQuotaFor(controlDb, tenantKey)` (tested) — no route passes it.
- **No farm, no `site.asset()`, no `/media/<key>`.** D18's `content/public/<key>.<ext>` symlink and the
  nginx hot path are S3b. Nothing in this slice can serve a byte.
- **No renditions.** `cms_asset_variant` is untouched; `width`/`height` are stored for images because the
  schema's `CHECK(kind <> 'image' OR (width IS NOT NULL AND height IS NOT NULL))` requires them.
- **PDF/MP4/MP3/ZIP are magic-checked and stored unchanged.** No parser, no re-encode, no metadata
  strip: a PDF's `/Info` dictionary and an MP4's `udta` box survive. That is a real gap for documents,
  and it belongs with the watermark/rendition work in S3b, not with a claim in this report that it is
  handled.
- **Video and audio are not watermarked** (§7.5 already says so in the spec).
- **The FK and the trigger are the same rule twice.** `cms_asset_link.asset_id … ON DELETE RESTRICT` and
  `trg_cms_asset_delete_guard` both refuse the delete; the trigger fires first and is what the gate
  observes. Proving the FK independently would mean dropping a frozen trigger inside a test, which is a
  worse trade than saying so here.
- **One extra `PRAGMA table_xinfo` per query resolve** (D6's intersection). Measured, not assumed:
  `make test-perf` P-1 `cost_ms_max` 0.0331 / 0.0158 / 0.0272 / 0.0183 / 0.0125 ms against the 1.5 ms
  ceiling, P-3 0.1029 ms — 4/4 pass, RC=0.
- **D6's wire gate registers its own route** (v1 has no source-consuming page).

---

## 7. What S3b must build first

**1. The public symlink farm and the URL that uses it** — `app/assets/farm.ts` plus `GET /media/<key>`
and `site.asset()`. This is first because S3a's store is currently invisible: a blob exists on disk and
no URL names it, and the farm is the component that must **refuse a gated row** (a gated asset has no
link at all, so `/media/<key>` is a 404 and not a permission check — F1, and the link-absence test every
bundle runs). Building renditions or the download plane before the farm would leave the one security
property of §7.1 unwitnessed for a whole slice.

Then, in this order: **renditions** (`cms_asset_variant` rows + the `thumb/md/lg/og` derive step, which
is what makes `sharp`'s dimension output worth storing); **`repoint`** (the bounded, audited rename with
`SKW_REPOINT_MAX_ROWS` and one `cms_audit` row — the half of §7.1 that `renameAsset` deliberately
refuses to be); and only then the download plane of §16 S3 (codes, tokens, redeem, `X-Accel-Redirect`,
watermark), which is S3c-sized on its own.

Two things S3b must not re-decide: the quota is checked in `putBytes` **before** the write, and the
checksum is over the stored bytes. An upload route written against a different rule would pass its own
tests and break `A6`/`path-check`.

---

## 8. Reproducing the gate

```
make test            # 333 tests, 333 pass, 0 fail, 0 skipped, RC=0
make test-perf       # 4 tests, 4 pass, RC=0 (idle box; the load guard refuses otherwise)
node scratch/s3a/proofs.ts
```

`hermes verify --json` on this tree, with the six boot keys set: `"ok": true` — bootstrap (`npm install`,
exit 0), build (`npm run build`, 0), typecheck (0), `npm run test` (333 pass, 0 fail, 38.5 s), `make test`
(333 pass, 0 fail), `make typecheck` (0), `make build` (0), readiness `http://127.0.0.1:4321/` → 200. The
boot is part of the evidence, so the `sharp` dependency added to `package.json` is proven to install and
load in the same environment the app starts in.

`make test` is unchanged in shape: `verify-toolchain` → `verify-gitignore` → `verify-schema` →
`verify-claims` → `verify-frozen` → `build` → `typecheck` → the node suite through
`scripts/run-node-tests.mjs` with `--test-timeout=40000`. `SKW_ALLOW_SKIP` was never set; no test in this
slice is skipped; no timing assertion was added to `test/`.

New rows the schema gate already prints for this area (unchanged by this slice, cited because they are
the DDL half of §7.1 and the store must agree with them):

```
asset identity and the generated path (C-17)
   ok INSERT naming the generated storage_path: rejected (cannot INSERT into generated column "storage_path")
   ok sha256 rewrite (address is immutable): rejected (SKW_E_DM_COLUMN_IMMUTABLE)
   ok generated path is derived from (sha256,mime): content/media/aa/aaaa….png
```
