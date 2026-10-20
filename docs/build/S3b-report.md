# S3b — the public asset farm, renditions, `site.asset()`, the media library, and D31

**Slice:** S3b (second half of §16 S3 — assets; the download plane is S3c).
**Tree:** `beb44d5` + the working tree below. **Not committed** (the brief's rule).
**Gate:** `make test` → **359 tests, 359 pass, 0 fail, 0 skipped, RC=0** (was 333; +26 new).
`make test-perf` → 4/4, RC=0. No timing assertion was added to `test/`.

Every claim below is followed by the command that produced it and the output that command
printed. Where a number came from a measurement rather than an assertion, it says so.

---

## 1. What this slice is

S3a ended at the database: a blob on disk and a row naming it, and no way to reach either over
HTTP. S3b is the **public plane**: the symlink farm nginx serves with no Node in the path, the
renditions `srcset` needs, the resolver that builds a URL from a key at render, and the admin
library a human picks an asset from. D31 rides in front of it because it is the one datasource
defect the S3a errata flagged and left open.

The one security property that shapes the whole slice: **a gated asset has no farm link at all.**
Not a link with a check — no link — so `/media/<gated-key>` is the same 404 `try_files` gives a
key that never existed, and the two responses are byte-identical.

## 2. The scope, item by item

| # | Item | Where it lives | State |
|---|---|---|---|
| 0 | **D31** — `limit_default > limit_max` refused at publish, and the default clamped at render anyway | `app/sources/spec.ts` (`DefaultAboveMax`), `publish.ts` (`refuse`), `resolve.ts` (`clamp`), `compile.ts` (clamp) | done, 4 gates + 3 mutations |
| 1 | **The symlink farm** — `content/public/<key>.<ext> → ../media/<hh>/<sha>.<ext>`, regenerated on create/rename/delete, gated rows absent | `app/assets/farm.ts`, wired in `library.ts` (`syncAssetLinks` on upload, the rename's three-step order, `retireFarm` on delete) and `renditions.ts` | done, 5 gates |
| 2 | **Renditions** — `cms_asset_variant` rows for thumb/md/lg/og × webp/avif, width/height/sha recorded, deterministic regeneration | `app/assets/renditions.ts` | done, 8 gates |
| 3 | **`site.asset('key')`** — `{url, srcset, width, height, alt}` with `/media/<key>.<ext>?v=<sha8>` built at render | `app/assets/url.ts`, `app/render/data.ts` (`asset()`) | done, in the renditions file (R3–R7) |
| 4 | **The admin media library** — thumbnail grid, search across key/filename/alt/kind, a picker that writes the key | `app/admin/routes.ts` (`media`, `media.json`) | done, 5 gates |

Files created: `app/assets/farm.ts`, `app/assets/renditions.ts`, `app/assets/url.ts`,
`test/farm.test.ts`, `test/renditions.test.ts`, `test/d31-limit.test.ts`,
`test/media-library.test.ts`, `test/nginx-media-e2e.test.ts`,
`test/helpers/farm-sampler.mjs`, `test/helpers/http-sampler.mjs`,
`scratch/s3b/{regen-conf,mutations,farm-probe}.ts`.

Files modified: `app/assets/library.ts` (farm sync on create/rename/delete),
`app/render/data.ts` (`asset()`), `app/sources/{spec,publish,resolve,compile}.ts` (D31),
`app/admin/routes.ts` (the library), `tools/nginx_gen.ts` + `nginx/templates/server.tmpl`
(the alias `map` and the `/media/` 301 line), `nginx/conf.d/10-app.conf` (regenerated),
`test/assets.test.ts`, `test/sources.test.ts` (two amendments, both argued in §7).

Not mine, and untouched: nothing. `git status` lists only the files above.

---

## 3. The acceptance criteria: command, output

### C1 — nginx serves `/media/<key>.<ext>` with Node not involved

The app is killed inside the test and the same URL is requested again. What is asserted is not
"nginx answered" but "the bytes are the farm link's bytes and the app path is dead".

```
$ node --test --test-concurrency=1 --test-timeout=180000 test/nginx-media-e2e.test.ts
ok 1 - N1 — with the app killed, /media/<key> is a 200 with the stored bytes and everything else is a 502
# # N1 app-killed: /healthz -> 502, /media/banner/home.jpg -> 200 (1226 B, sha256 5a809698), farm link sha256 5a809698
ok 2 - N2 — a gated asset is 404 and its body is identical to a key that never existed
ok 3 - N3 — a rename never leaves both URLs dead (HTTP-sampled), and the old URL then 301s
ok 4 - N4 — a delete removes the link and the alias: both URLs are 404 after a reload
# tests 4
# pass 4
# fail 0
```

The pair of numbers is the proof: **`/healthz` 502 and `/media/…` 200 in the same run**, after
`handle.close()`. A proxied path lost its upstream; the media path never had one. The rendition
`/media/banner/home@thumb.webp` is asserted in the same test (also 200, also after the kill) —
so the proof covers the farm's variant links, not only the blob link.

### C2 — a gated asset has no link, and its 404 is the missing-key 404

```
$ node --test --test-concurrency=1 --test-name-pattern="F2" test/farm.test.ts
ok 1 - F2 — a gated asset has NO link, by key and by checksum; flipping it public creates one
```

```
$ node --test --test-concurrency=1 --test-timeout=180000 --test-name-pattern="N2" test/nginx-media-e2e.test.ts
ok 1 - N2 — a gated asset is 404 and its body is identical to a key that never existed
# # N2 gated 404 body sha256 9f6d0b634cab6787cdebb2a02e08a2e2ff6d8863344e46aa7bf387e607b827c3 (153 B) == missing 404 body sha256 9f6d0b634cab6787cdebb2a02e08a2e2ff6d8863344e46aa7bf387e607b827c3
```

The 153 B is nginx's own 404 page, byte-identical for the gated key and for `never/existed.jpg`,
and the headers are compared field by field with `date`/`etag` blanked. There is no oracle.

`F2` is the link-absence test §7.1 requires, in code:

- `linksPointingAt(contentRoot, gatedSha)` → `[]` (nothing in `content/public` names the gated
  checksum, so the `find -lname "*<sha>*"` of the spec and this assertion are the same fact);
- the bytes *do* exist at `content/media/<hh>/<sha>.png` — the asset is real, only unreachable;
- **the control**: flipping the row to `public` and syncing creates
  `['vault/paid-photo.png']`, and flipping it back removes it in the same call. The absence is
  caused by the access class, not by a writer that never writes.

`N2` also runs the literal `find content/public -lname '*paid*'` and asserts an empty stdout.

### C3 — rename: old 301s via the alias, new serves, never a moment with neither

Two witnesses, because they fail differently: one on the filesystem, one through real nginx.

**Filesystem, sampled by a second process** (the rename is synchronous JS, so an in-process
sampler would report a window it never observed):

```
$ node --test --test-concurrency=1 --test-name-pattern="F3" test/farm.test.ts
ok 1 - F3 — a rename leaves no moment where neither URL resolves, and the map names old -> new
```

**Through real nginx, sampled by a second process over HTTP** (a name "resolves" if nginx
answered 200 *or* 301 — 404 is the only answer that means gone):

```
$ node --test --test-concurrency=1 --test-timeout=180000 --test-name-pattern="N3" test/nginx-media-e2e.test.ts
ok 1 - N3 — a rename never leaves both URLs dead (HTTP-sampled), and the old URL then 301s
# # N3 samples 1995, dead 0, sawOld 64, sawNew 1936, old statuses [200,404], new statuses [200,404]
```

1995 samples across the rename, **0 in which both URLs failed**, 64 saw the old name still
serving and 1936 saw the new name already serving. The statuses show the transition (200 while
the old link lived, 404 once it was gone and the map had not reloaded yet) and the new name's
404→200. Then, after `nginx -s reload`:

```
assert.equal(redirect.status, 301)
assert.match(location, /\/media\/campaign\/spring\.jpg\?v=[0-9a-f]{8}$/)
assert.equal(location.split('?v=')[1], newSha.slice(0, 8))   # the 301 carries the current version
```

The container's own `cat /srv/content/edge/media-aliases.inc` is asserted before the reload, so
a 301 served from a stale map cannot pass.

**Why the order is the guarantee.** `renameAsset` does: (1) create the new links — new serves;
(2) rewrite the alias map — the edge *can* 301; (3) only then remove the old links. Between 1
and 3 both URLs serve; after 3 the old one is a 301 the map answers. There is no step at which
neither resolves, which is exactly what the sampler measures.

### C4 — delete removes the link and the alias cascades

```
$ node --test --test-concurrency=1 --test-name-pattern="F4" test/farm.test.ts
ok 1 - F4 — delete removes the link, and the alias it cascaded stops being a 301
```

```
$ node --test --test-concurrency=1 --test-timeout=180000 --test-name-pattern="N4" test/nginx-media-e2e.test.ts
ok 1 - N4 — a delete removes the link and the alias: both URLs are 404 after a reload
```

`F4` asserts the link is gone, `cms_asset_alias` has 0 rows for the old key (the DDL's
`ON DELETE CASCADE`), and the map file no longer names either key. `N4` asserts the same two
facts through nginx after a reload: `/media/campaign/spring.jpg` 404 and
`/media/campaign/summer.jpg` 404 (not a 301 — a redirect to a deleted file is a redirect to a
404, which is why the delete republishes the map).

### C5 — the same image twice yields identical rendition bytes, and the sha matches the row

```
$ node --test --test-concurrency=1 --test-name-pattern="R1|R2" test/renditions.test.ts
ok 1 - R1 — the same image uploaded twice yields identical rendition bytes, and each sha is the file
ok 2 - R2 — regeneration is deterministic: a second derive changes neither bytes nor rows
```

`R1` compares two assets over the same upload, label by label:
`label/format:sha:widthxheight` deep-equal, then for every row `sha256(file on disk) ===
row.sha256`, `file.length === row.bytes`, and `sharp(file).metadata()` equals the recorded
width/height. `R2` derives twice and deep-equals the rows, and plans twice from the stored bytes
to show the encoder itself is deterministic.

The one honest note: at a 900×600 source, `lg` and `og` encode the same 900×600 pixels and are
legitimately **one blob with two rows** — dedupe, not a collision. The gate asserts the path is
a function of the sha, not that rows and paths are one-to-one.

### C6 — `?v=` changes when the bytes change, and not when only the key is renamed

```
$ node --test --test-concurrency=1 --test-name-pattern="R4" test/renditions.test.ts
ok 1 - R4 — ?v= changes when the bytes change, and survives a rename unchanged
```

- before rename: `/media/card/a.jpg?v=<8hex>`;
- after rename: `/media/card/b.jpg?v=<same 8hex>` — the key moved, the version did not;
- the old key still resolves through the alias, to the *new* URL;
- different bytes under a different key → a different `?v=`.

### C7 — `srcset` carries the labels and widths the rows hold, compared to the DB

```
$ node --test --test-concurrency=1 --test-name-pattern="R3" test/renditions.test.ts
ok 1 - R3 — srcset carries the labels and widths the variant rows hold, not a constant table
```

Every candidate is parsed with `^(/media/(.+)\?v=([0-9a-f]{8})) (\d+)w$`, matched to its
`cms_asset_variant` row by name, and compared on **width and version from the row** — a constant
table in code would fail this. It also asserts the widths are ascending and that the distinct
widths are `[320, 768, 1200, 1280]` for a 1600 px source, i.e. the labels the rows carry.

### C8 — D31: publish refusal and render clamp, each with a mutation control

```
$ node --test --test-concurrency=1 test/d31-limit.test.ts
ok 1 - D31-0. control — limit_default below limit_max publishes and renders that many rows
ok 2 - D31-1. publish refuses limit_default > limit_max, names the field, and writes no row
ok 3 - D31-2. a spec that bypassed publish renders clamped to limit_max, not refused and not 50
ok 4 - D31-3. compile() clamps a hand-built spec, so the clamp is not only a parse-time habit
# tests 4
# pass 4
# fail 0
```

- **D31-1** is `422 SKW_E_RT_SOURCE_UNKNOWN`, `reason='param_invalid'`, `detail.param='limit'`,
  `detail.field='limit_default'`, `detail.limit_default=50`, `detail.limit_max=5` — the shape
  E-24's matrix gives every invalid limit, with the field named because `limit_max` is a legal
  value here. `cms_datasource` row count is unchanged, and a direct count for the key is 0.
- **D31-2** inserts a row straight into `cms_datasource` (`spec_json` is checked for
  `json_valid` and nothing else) with `{limit_max: 5, limit_default: 50}`, then resolves it:
  `limit === 5`, `rows.length === 5`, `truncated === false` (a clamp is not a truncation). The
  control in the same test is the same row with `limit_default: 4` → 4.
- **D31-3** hands `compile()` a hand-built `SourceSpec` with `limitDefault: 50, limitMax: 5`
  and asserts the bound `LIMIT` parameter is 5 — the clamp a caller cannot skip by not going
  through `parseSpec`.

**Mutation controls** (`node scratch/s3b/mutations.ts`), each removing one mechanism and running
that mechanism's gate:

```
M1 — publish stops refusing limit_default > limit_max -> test/d31-limit.test.ts (.): exit=1 passed=3 failed=[D31-1. publish refuses limit_default > limit_max, names the field, and writes no row]
M1 — publish stops refusing limit_default > limit_max: file restored IDENTICAL
M2 — the render parse stops clamping (D31-2 owns this clamp) -> test/d31-limit.test.ts (.): exit=1 passed=3 failed=[D31-2. a spec that bypassed publish renders clamped to limit_max, not refused and not 50]
M2 — the render parse stops clamping (D31-2 owns this clamp): file restored IDENTICAL
M2b — compile stops clamping a hand-built spec (D31-3 owns this one) -> test/d31-limit.test.ts (.): exit=1 passed=3 failed=[D31-3. compile() clamps a hand-built spec, so the clamp is not only a parse-time habit]
M2b — compile stops clamping a hand-built spec (D31-3 owns this one): file restored IDENTICAL
M4 — putBytes writes a second real file (A1 must still notice) -> test/assets.test.ts (A1): exit=1 passed=0 failed=[A1 — the same bytes twice produce one file]
M4 — putBytes writes a second real file (A1 must still notice): file restored IDENTICAL
M3 — the farm links a gated asset -> test/farm.test.ts (F2): exit=1 passed=0 failed=[F2 — a gated asset has NO link, by key and by checksum; flipping it public creates one]
M3 — the farm links a gated asset -> test/nginx-media-e2e.test.ts (N2): exit=1 passed=0 failed=[N2 — a gated asset is 404 and its body is identical to a key that never existed]
M3 — the farm links a gated asset: file restored IDENTICAL
```

Each mutation reddens **only** its own test (`passed=3` of 4 in the D31 file), which is what
makes each an exclusive witness rather than a second opinion about the same branch. M4 exists
for the one existing gate this slice amended (§7). Every file is restored byte-identically;
`sha256` prefixes are compared before and after and printed as `IDENTICAL`.

### C9 (item 4) — the media library

```
$ node --test --test-concurrency=1 test/media-library.test.ts
ok 1 - M1 — the grid renders a thumbnail per image, linked to the farm URL the variant row names
ok 2 - M2 — a gated asset is listed but offers no public URL, and the picker refuses it
ok 3 - M3 — search matches key, filename, alt text and kind, and nothing else
ok 4 - M4 — media.json reports the farm URL for a public asset and null for a gated one
ok 5 - M5 — the library is a read surface: no route writes, and no session means no library
# tests 5
# pass 5
# fail 0
```

- the grid is `<figure data-asset-key="brand/logo" …><img src="/media/brand/logo@thumb.webp?v=…">`
  — the farm's names, and `alt` from `alt_text`;
- a gated row is listed with `gated — no public URL` and **no** `src="/media/vault/…`;
- the picker is server-rendered, so "writes the key" is an assertion on HTML:
  `?pick=cover&key=brand/logo` renders `<input name="cover" value="brand/logo" readonly>`, and
  the same request for the gated key renders no field at all;
- search is bound parameters with `ESCAPE '\'`: `q=%` matches nothing (a typed wildcard is a
  character), `q=image` matches the three images by kind, `q=terms.pdf` by filename.

---

## 4. The nginx-without-Node proof, in full

The harness is the S1 edge gate's, unchanged: `nginx:1.31-alpine`, the config
`tools/nginx_gen.ts` generates, the snippet `install.sh` renders into
`/etc/nginx/snippets/skunk-proxy.conf`. Two substitutions and no others, each counted:
`listen 443 ssl;` removed (TLS is not under test) and `proxy_pass http://app:3000` →
`http://<gateway>:<appPort>` (the app runs on the host). The test asserts the generated file
still contains the `/media/` location — `alias /srv/content/public/` and `try_files $uri =404` —
so a generator change cannot make the gate silently stop testing the edge it claims to.

```
$ node --test --test-concurrency=1 --test-timeout=180000 test/nginx-media-e2e.test.ts
# # N1 app-killed: /healthz -> 502, /media/banner/home.jpg -> 200 (1226 B, sha256 5a809698), farm link sha256 5a809698
```

Three readings of one fact, because a 200 alone proves only that *something* answered:

1. **The bytes** — 1226 B returned, sha256 `5a809698…`, equal to the bytes the farm link
   resolves to on the host.
2. **The upstream** — `/healthz` through the same nginx is **502** at the same moment. The app
   process was closed by the test (`await handle.close()`), so nothing listens on the upstream
   port; if `/media/` were proxied it would be 502 too.
3. **The headers** — `Cache-Control: public, max-age=31536000, immutable` from the generated
   location, which a proxy would have passed through from the app (the app sets `no-store` on
   every response it writes).

A second, independent confirmation of the same mechanism outside the suite
(`node scratch/s3b/farm-probe.ts`, a throwaway probe that starts the same image against a
hand-built tree):

```
media files: 5
  variant thumb/avif content/media/58/58e9185…af95c4.avif exists=357
  variant thumb/webp content/media/d5/d50a3fa…4b3e892.webp exists=218
  link /public/banner/home.jpg -> ../../media/5a/5a809…fc730.jpg
GET /media/banner/home2.jpg -> 200
GET /media/banner/home2@thumb.webp -> 200
GET /media/banner/home.jpg -> 301
```

and the generated fragment it served the 301 from:

```
map text:
# GENERATED by app/assets/farm.ts from cms_asset_alias — do not edit by hand.
# Included inside `map $uri $skw_media_alias` in the file tools/nginx_gen.ts emits.
# A 301 here is the edge answering a renamed key without a database.
/media/banner/home.jpg /media/banner/home2.jpg?v=5a809698;
```

## 5. Rename atomicity evidence

Two observations, at two layers, from two processes:

| Layer | Command | Measurement |
|---|---|---|
| filesystem | `node --test --test-name-pattern="F3" test/farm.test.ts` | samples both names with `readFileSync` while the rename runs; asserts `dead === 0` and that the reader saw both names |
| HTTP through nginx | `node --test --test-name-pattern="N3" test/nginx-media-e2e.test.ts` | 1995 samples, **dead 0**, sawOld 64, sawNew 1936; then 301 + `?v=` + 200 on the target |

Both samplers are separate OS processes (`test/helpers/farm-sampler.mjs`,
`test/helpers/http-sampler.mjs`) for the same reason: a synchronous rename cannot be observed
from the process performing it, and a sampler that runs only before and after would report a
window it never looked at. That failure mode was hit while building this gate — the first
version of `F3` reported `only 1 samples`, and the assertion is what caught it.

## 6. Decisions, and the reasoning that made them

1. **The alias 301 is a generated `map`, not a database lookup.** `map` is http-scope only, so
   `nginx_gen` emits the block and `farm.ts` writes the entries into an include *inside* it
   (`content/edge/media-aliases.inc`, glob-included). Two shapes were rejected: a per-tenant
   `map` variable (the tenant list is dynamic, the variable names are static) and an `if` over
   a link's presence (a link cannot express "gone but redirected"). The glob include is what
   makes a fresh box start: nginx tolerates an include mask that matches nothing, and the
   variable is declared by the block rather than by the file.
2. **A reload is required for a rename's 301, and the test says so.** `map` is read when nginx
   loads its config. The farm's three-step order means the old URL answers with *bytes* until
   the reload and with a *301* after it — both correct, and neither 404. The e2e asserts the
   container's own view of the include, then reloads, then polls the end state (a reload is
   asynchronous; the first attempt at this test raced it and got the old worker's 404).
3. **A variant's link is published by the module that writes the row.** `ensureVariants` calls
   `syncAssetLinks` at the end; without it, `srcset` advertised URLs nginx 404'd — a real bug
   the e2e found on its first run (`/media/banner/home@thumb.webp -> 404` with the row present).
4. **A key may contain `/`, so a link may nest, so the target's depth is computed.** The schema
   allows `banner/home` and `assetRefsInHtml` already supports it; the relative target is
   `../` per level (`../../media/…` for a two-segment key), and `publishLink` creates the
   parent directory. `listLinks` walks, because a rename of a nested key must find every link.
5. **Gated and `linked-private` are different in the farm.** `gated` gets no link; `linked-private`
   gets a link like a public asset, because §7.2's third class is "public URL, unguessable key"
   and the download plane's codes never depend on the farm's absence. Only `gated` is
   structurally absent, which is the distinction F1 rests on.
6. **`site.asset()` returns `url: null` for a gated asset.** The five keys are fixed by the
   contract; a URL for an asset with no link would be a 404 dressed as a resource, and a
   template writing `src={asset.url}` would publish a broken image instead of failing loudly.
7. **The library's picker writes a key, never a URL.** Content that stored a URL would have to
   be rewritten by every rename (§7.3); the picker is server-rendered (`?pick=cover&key=…`) so
   "it wrote the key" is a statement about HTML rather than about a JavaScript handler nothing
   executes in this suite.
8. **`?v=` is the checksum's first 8 characters.** It changes when the bytes change and does not
   change when only the key is renamed, which is the two-line proof that a URL is derived rather
   than stored.

## 7. Two existing gates amended, and why neither was weakened

- **`test/assets.test.ts`'s `tree()` now skips symlinks.** S3b's farm puts one link per public
  asset under `content/public/`, so a tree that counted entries would have reported "two files"
  for one blob. A symlink is not a byte, and this tree is the **store**. The gate keeps its
  teeth: **M4** adds a second real file inside `putBytes` and `A1` still fails
  (`2 !== 1`). The `filter(e => e.includes(sha)).length === 1` assertion is unchanged in intent.
- **`test/sources.test.ts` S2E-9 now expects `['source', 'asset']`.** §7.3 added the second
  accessor; the test's subject is the *surface* (named accessors, no `db`, no `prepare`, no
  handle), and it still asserts an exact list, so a third unnamed escape hatch fails here.

Neither amendment weakens a rule; both are the same rule stated against a tree/surface that now
has one more legitimate element.

## 8. Known limits, stated rather than implied

- **One content root is one key namespace.** §7.1's URL is `/media/<key>.<ext>` and the farm is
  `content/public/<key>.<ext>`, so two tenants sharing a content root (`docker-compose.yml`'s
  single `./content` volume) share a namespace even though `cms_asset.key` is unique per
  `site.db`. The deploy-per-tenant layout is safe; the shared-volume layout needs either a
  key prefix in the URL or one root per tenant. **For S3c/Architect**: this is a decision, not a
  bug I can fix from one `site.db`.
- **The alias `map` is per content root, not per host.** It inherits the same namespace
  assumption as the links; a shared root with two tenants renaming the same key is the same
  collision, and the map is keyed by `$uri`, not `$host$uri`, for that reason.
- **No upload route and no delete route in admin.** The library reads; `uploadAsset` still has
  no HTTP caller (S3a's stated gap). The admin upload screen remains unbuilt.
- **No `repoint`.** `renameAsset` still refuses a referenced key (`409 SKW_E_DM_KEY_IN_USE`);
  the bounded, audited rewrite with `SKW_REPOINT_MAX_ROWS` is not built (S3a deferred it to S3b;
  it is not in this slice's five items and is not claimed).
- **PDF/MP4/MP3/ZIP still have no renditions and no metadata strip.** `ensureVariants` returns
  `[]` for a non-image, and `site.asset` returns a URL with an empty `srcset`. The S3a report's
  gap stands.
- **The bundle link-absence test is a helper, not a bundle gate.** `linksPointingAt` is what
  §7.1's test needs, and `N2` runs the literal `find`. `tools/bundle_verify.mjs` does not yet
  call it; that is S3c's (or the exporter's) work.
- **One pre-existing check is wall-clock, and it says so.** `verify-claims` check 7 measures the
  cost of an argon2 equality scan and fails if the box is faster than the claim ("scan cost only
  298.0s"). It failed once while this slice's suite was hammering the CPU and passed on an idle
  rerun (`27/27 passed, 0 skipped, 0 failed`). Nothing in this slice touches it; recording it
  because a reader of the log deserves to know it is a measurement of the machine.
- **`make test-perf` unchanged**: 4/4, `P-1` `cost_ms_max` 0.0336/0.0148/0.0139/0.0191/0.0161 ms
  against the 1.5 ms ceiling, `P-2` 43.03 ms refusal, `P-3` 0.0385 ms, `P-4` ratio 1.024.

## 9. What S3c must build first

**1. The download plane's `X-Accel-Redirect` hand-off, against `content/media/` as it is now
laid out.** The farm proved that nginx can serve a *public* byte with no Node; the gated half
of §7.1 is the same edge with `internal` — the app authorises, then hands off
`/__protected/<sha>.<ext>` and never sees a byte. It is first because the farm has now fixed the
tree the hand-off must point at (`storage_path`, the `hh/` fan-out, the variant blobs' naming),
and because a download route written before that layout settled would encode a second one.

Then, in this order: **`repoint`** (the bounded, audited rename with one `cms_audit` row — the
half of §7.1 `renameAsset` refuses to be, and the operation the alias map already anticipates);
the **admin upload/delete routes** (the library reads; nothing writes); and the **bundle
link-absence gate** (`linksPointingAt` wired into `tools/bundle_verify.mjs`, so every bundle
runs §7.1's test rather than one suite running it once).

Two things S3c must not re-decide: a gated asset has **no** farm link (F2/N2/M3 are the gate),
and a URL is built at render from a key with `?v=<sha8>` (R4 is the gate). A download route that
minted a symlink "for speed" would re-open F1 with a passing test of its own.

## 10. Reproducing the gate

```
make test                      # 359 tests, 359 pass, 0 fail, 0 skipped, RC=0
make test-perf                 # 4 tests, 4 pass, RC=0 (idle box; the load guard refuses otherwise)
node scratch/s3b/mutations.ts  # the mutation controls (5 mutations, 6 gate runs), each restored IDENTICAL
node scratch/s3b/regen-conf.ts # regenerate nginx/conf.d/10-app.conf (155 lines)
node scratch/s3b/farm-probe.ts # a hand-built farm + a real nginx: 200/200/301
```

`hermes verify --json` on this tree, with the six boot keys set: `"ok": true` — bootstrap
(`npm install`, exit 0), build (`npm run build`, 0), typecheck (0), `npm run test` (359 pass,
0 fail, 48.4 s), `make test` (0, 65.4 s), `make typecheck` (0), `make build` (0), readiness
`http://127.0.0.1:4321/` → 200. The first attempt at this ran `npm run test` immediately before
`make test` and failed only `verify-claims` check 7 — the argon2 wall-clock measurement named in
§8 — and passed unchanged on a second run; no threshold was touched.

`make test` is unchanged in shape: `verify-toolchain` → `verify-gitignore` → `verify-schema` →
`verify-claims` → `verify-frozen` → `build` → `typecheck` → the node suite through
`scripts/run-node-tests.mjs` with `--test-timeout=40000`. `SKW_ALLOW_SKIP` was never set; no
test in this slice is skipped; no timing assertion was added to `test/` (the two samplers assert
counts and end states, never a duration).

`make test` now includes the Docker-backed `test/nginx-media-e2e.test.ts` (and the pre-existing
`test/nginx-e2e.test.ts`), so a box with no daemon fails loudly rather than skipping —
`SKW_SKIP_DOCKER=1` remains the only deliberate skip, and the suite treats a skip as a failure.
