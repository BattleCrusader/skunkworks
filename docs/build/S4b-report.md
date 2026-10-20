# S4b — the projection, and three targets that are one render mode

**Tree:** `0897b08` + this working tree, **uncommitted**, as instructed. Production:
`app/render/body.ts` (new), `app/export/**` (new: `project.ts`, `document.ts`, `tree.ts`,
`notes.ts`, `static.ts`, `astro.ts`, `cms.ts`, `lockfile.ts`, `index.ts`), `app/cli/export.ts`
(new), `app/main.ts` (the serve path now renders through the projection), `app/errors.ts` and
`schema/error-codes.json` (two codes). Tests: `test/export-projection.test.ts`,
`test/export-targets.test.ts`, `test/export-determinism.test.ts` (new), `test/error-codes.test.ts`
(the count, 76 → 78). Evidence: `scratch/s4b/**`.
**Gate:** `make test` **490/490, 0 failed, 0 skipped, RC=0**; `verify-dist 6/6`;
`verify-no-leak: clean`. `SKW_ALLOW_SKIP` was never set; no gate was weakened.

| # | Item | Verdict | § |
|---|---|---|---|
| 1 | the projection + four named refusals | **done** — 8 gates, incl. both legacy body shapes | §2 |
| 2 | CMS bundle, `bundle_verify` clean | **done** — 18 files, 17 hashed and verified, boots and serves | §3 |
| 3 | Astro project (D24) | **done** — `npx astro build`, 4 pages, byte-identical output | §4 |
| 4 | static HTML+JS | **done** — 9 files, served by a plain file server | §5 |
| 5 | determinism | **done** — three trees byte-identical at one clock, one line different at two | §6 |
| — | the shared-path mutation | **proved** — one line, four red gates, revert green | §7 |

---

## 1 — What the export is, in one paragraph

`buildProjection()` reads `cms_page.body_html`, sends every row through
**`renderStoredBody()`** — the function the Fastify serve path now calls too — and returns
either a `Projection` or a list of refusals. The three writers receive that object and only
lay bytes on disk. Nothing else in the tree reads `cms_page`, derives an asset URL or parses
`body_html`. `projectionSha` (`contentSha:mediaSha`) is the same string in all three trees,
and `test/export-projection.test.ts` P7 asserts it.

The site wiring is the part that makes the export's bytes the site's bytes *by construction*:
`app/main.ts` now passes `{...page, bodyHtml: renderStoredBody(db, page.bodyHtml)}` to the Astro
shell. Before this slice the serve path never called `renderBody()`, so a live page shipped

```
<img data-asset-key="work/one" alt="One">
```

with no `src` — measured (`scratch/s4b/served-about.html`, probe 1). That was a real D17 defect
in the product, not only a gap in the exporter; it is now fixed and gated (T0).

The cost is one parse + serialise per page render, measured on the demo corpus:

```
$ node -e "… 2,000 × renderStoredBody(db, body) on /about (119 B) …"
body bytes 119 per render 0.069 ms
```

69 µs against a request that has already opened a SQLite handle and will run Astro's SSR.
No cache and no fast path were added: a fast path ("skip the parse when the body has no
`data-asset-key`") is only sound if `serialize(parseHtml(x)) === x` for every stored row, and
that identity has not been measured — it is the same class of assumption S4a's fixpoint gate
exists to refuse.

## 2 — The projection and its refusals

`app/export/project.ts`. Four conditions, each with its own code and §11.3 exit:

| Condition | Code | Exit | Names |
|---|---|---|---|
| a gated key is referenced by a page the Astro/static target will render | `SKW_E_EXP_GATED_ASSETS` | 21 | every key **and** every page |
| a gated asset is linked from an owner the target carries but the asset is not | `SKW_E_EXP_MEDIA_GRAPH_OPEN` | 21 | the key, the owner kind and id |
| a `free` parameter appears in a link on an exported page | `SKW_E_EXP_PARAMETERISED` | 22 | the source, the parameter, the link, the page |
| a legacy row is still a document after `unwrapBody()`, or names an asset with no row/bytes | `SKW_E_EXP_BODY_UNNORMALISABLE` / `SKW_E_EXP_ASSET_UNRESOLVED` | 21 | the page and the rule, or the key |

Two new codes; the taxonomy's count gate moved with them (76 → 78,
`test/error-codes.test.ts`).

The gated scan reads the **stored** bytes with `assetRefsInHtml()` — the same reader that
writes `cms_asset_link` — because the rendered bytes carry URLs and a gated asset has none, so
scanning after the render would miss exactly the asset the refusal is for. The CMS bundle is
exempt from refusal 1 by §11.1's own table ("Gated downloads: yes"); it carries the gated rows
and the redeem plane.

```
$ node --test --test-concurrency=1 test/export-projection.test.ts
ok 1 - P1 — a `<body>`-wrapped row from before 436d913 normalises through the one unwrapper
ok 2 - P2 — a row that is still a document after unwrap is refused as BODY_UNNORMALISABLE, naming the page
ok 3 - P3 — a gated asset in a static export is REFUSED naming the key and the page; the CMS bundle ships it
ok 4 - P4 — a `free` parameter in a link refuses with PARAMETERISED, naming the source and the link
ok 5 - P5 — a gated asset linked from a carried owner refuses as MEDIA_GRAPH_OPEN
ok 6 - P6 — an empty body exports as an empty <main>, and an asset with no bytes refuses as ASSET_UNRESOLVED
ok 7 - P8 — a tenant with audit rows exports: the table ships empty and its no-delete trigger is still there
ok 8 - P7 — the three targets carry one projection_sha, and it is the same number in all three trees
# tests 8   # pass 8   # fail 0
```

Both legacy shapes are gated: P1 normalises `<body>…</body>` to the fragment; P2 refuses
`<body><body>…` with the page and `rule: 'body-document'`. P6's second half removes an asset's
bytes from disk and gets `ASSET_UNRESOLVED` naming the key — a bundle with a dangling asset is
not a smaller bundle, it is a broken site.

At the command, the same refusal, with nothing written:

```
$ node app/cli/export.ts --target static --tenant acme --out scratch/s4b/demo-gated/out/static \
    --data-dir scratch/s4b/demo-gated/data --origin https://acme.test --now 2026-10-20T12:00:00.000Z
REFUSAL: SKW_E_EXP_GATED_ASSETS {"target":"static","keys":["vault/rate-card"],"pages":["/pricing"],
  "assets":[{"key":"vault/rate-card","page":"/pricing"}]}
skw-export: refused; nothing was written to scratch/s4b/demo-gated/out/static
rc=21
$ ls scratch/s4b/demo-gated/out
ls: … No such file or directory
```

**Found while building P8, and fixed.** `cms_audit` has a `BEFORE DELETE` trigger that raises
`SKW_E_DM_COLUMN_IMMUTABLE`, and §11.2 says the table ships **empty**:

```
$ node -e "… insert one cms_audit row, then DELETE FROM cms_audit …"
DELETE FROM cms_audit -> SKW_E_DM_COLUMN_IMMUTABLE
```

so a bundle export of any *real* tenant — one whose site our operators have worked on — would
have aborted, while an empty fixture passed. `applyProjection()` now drops the `BEFORE DELETE`
triggers of the `empty` tables inside the transaction, deletes, and re-creates them from their
own `sqlite_master.sql` before `COMMIT`. The bundle's schema is the tenant's schema, not a
weakened one: P8 asserts 0 audit rows **and** the trigger is back.

## 3 — Target 1: the CMS bundle

`app/export/cms.ts`. 18 files, 387,857 B:

```
$ node app/cli/export.ts --target cms --tenant acme --out scratch/s4b/demo/out/cms \
    --data-dir scratch/s4b/demo/data --origin https://acme.test --now 2026-10-20T12:00:00.000Z
export: target=cms tenant=acme out=scratch/s4b/demo/out/cms files=18 bytes=387857
projection_sha: fa564d01fe824b992396230ea6955b5abbb28883d3b955869e556a613f4eb59b:c621302084642bc40edfa4449caed7790f3b03893afc28e3adf8a54139b2e6ad
tree_sha256: 42fd728d5b53838d619224b74a75a38cf23e9a73afd12d550b3b7d140aaf1859
export_now: 2026-10-20T12:00:00.000Z

$ node tools/bundle_verify.mjs --bundle scratch/s4b/demo/out/cms
bundle_verify: 17 file(s) verified, no render tree, no render rows
```

| path | what it is |
|---|---|
| `docker-compose.yml` | the repo's, with the app/runner digests the bundle was cut from |
| `install.sh` | the repo's, `0755` |
| `nginx/{nginx.conf,conf.d/00-default.conf,conf.d/10-app.conf}`, `snippets/skunk-proxy.conf` | `10-app.conf` is **generated for this tenant only** by `generateAppConf()` — copying the platform's `conf.d` would carry every other client's `server_name` into a bundle |
| `schema/{control.sql,site.sql}`, `tools/{bundle_verify.mjs,seed_control.mjs}` | what `install.sh` runs from the bundle root |
| `data/site.db` | `VACUUM INTO`, then the export projection applied (`empty` → no rows, `filtered` → no operator row), `foreign_key_check` silent |
| `data/control.seed.json` | the frozen seed re-pointed at this tenant: `mode='production'`, its hosts, one `owner` claim marker with `totp_secret: null` |
| `content/media/**`, `content/public/**` | the library, and one **relative** symlink per non-gated row |
| `BUNDLE.json`, `EXPORT-NOTES.md` | the manifest (`schema`, `export_now`, `tenant`, `hosts`, `image`, `projection_version`, `projection_sha`, `source_counts`, `files[]`, `plugins`, `refusals`, `notes`) |

**The seed's password hash is the frozen `schema/control.seed.json` one, not a fresh random
one.** §11.6 asks for "a real argon2id hash of 32 random bytes discarded at export"; a random
salt per export would make two exports of one database differ, which the same §6.4 forbids. The
bytes are discarded either way, so a fixed hash is not weaker — and it is the hash the install
path already proves.

**The counts are the producer's (§11.4).** Every table is counted on the source before the
snapshot, on the source after it, and inside the snapshot; `countsAgree()` compares them for
every `rows` table. A mismatch raises `SKW_E_EXP_NOT_QUIESCENT` (24) rather than a note. The
comparison is a pure function so the refusal is testable without a second writer.

**T3 boots the product against the bundle** — a fresh control.db, the bundle's own
`data/site.db` as the tenant, the bundle's own `content/` — and compares five pages to the live
site's responses. It also asserts, from the bundle's tree and database: no `control.db`, no
`-wal`/`-shm`, no `content/sources/`, no `content/protected`, no `content/edge/`, and every
`empty` table §11.2 names carries 0 rows (T4 asserts five of them, plus `cms_audit` in P8).

## 4 — Target 2: the Astro project (D24)

16 files, 135,587 B. Source, not a dump:

```
src/pages/{index,about,pricing,legacy}.astro     one page each, a component call with its title/path/CSS
src/content/pages/{index,about,…}.html           that page's body fragment — the file a human edits
src/components/Shell.astro                       the same document the product serves
public/media/**                                  the bytes at the URL the page already names
package.json, package-lock.json, astro.config.mjs, README.md, EXPORT-NOTES.md
```

`package-lock.json` is the platform's resolved lock **filtered to astro's closure** — every
`resolved`/`integrity` copied verbatim, and no dependency of the product travels (no
`better-sqlite3`, `fastify`, `grapesjs`, `pdf-lib`, `prettier`; `sharp` is in astro's own
closure). `filterLockfile()` walks npm's resolution (nested `node_modules` included) and
returns `null` rather than shipping a lock `npm ci` would refuse.

```
$ cp -R scratch/s4b/demo/out/astro /tmp/skw-s4b-build && ln -s $PWD/node_modules /tmp/skw-s4b-build/node_modules
$ (cd /tmp/skw-s4b-build && npx astro build)
02:03:47   ├─ /legacy/index.html (+3ms)
02:03:47   ├─ /pricing/index.html (+3ms)
02:03:47   ├─ /index.html (+4ms)
02:03:47 ✓ Completed in 171ms.
02:03:47 [build] 4 page(s) built in 413ms
02:03:47 [build] Complete!

$ python3 -m http.server 8791 --directory /tmp/skw-s4b-build/dist
GET /about/ -> 200 441 B
<!DOCTYPE html>
<html lang="en" data-tenant="acme">
  <head>
    <meta charset="utf-8">
    …
    <title>About &amp; Co &lt;ltd&gt;</title>
    …
  <body data-page-path="/about">
    <main><div data-gjs-type="prose" class="prose"><p>We are a <a data-asset-key="team/studio" href="/media/team/studio.jpg?v=818885cc">small team</a>.</p></div></main>
```

The build is run in a **copy** by the gate: `node_modules` and `dist/` inside the deliverable
would change the tree hash the determinism gate compares, and `dist/` is exactly what D24 says
must not be the shipped artefact.

## 5 — Target 3: static HTML + JS

9 files, 4,058 B: `index.html`, one directory per path, `media/**`, `robots.txt`,
`sitemap.xml`, `EXPORT-NOTES.md`.

```
$ python3 -m http.server 8792 --directory scratch/s4b/demo/out/static
$ curl -s -o /dev/null -w '/about -> %{http_code} %{redirect_url}\n' http://127.0.0.1:8792/about
/about -> 301 http://127.0.0.1:8792/about/      # one directory per path: the server's own redirect
$ curl -s -o /dev/null -w '/about/ -> %{http_code} %{size_download} B\n' http://127.0.0.1:8792/about/
/about/ -> 200 441 B
$ curl -s http://127.0.0.1:8792/about/
<!DOCTYPE html>
<html lang="en" data-tenant="acme">
  …
  <body data-page-path="/about">
    <main><div data-gjs-type="prose" class="prose"><p>We are a <a data-asset-key="team/studio" href="/media/team/studio.jpg?v=818885cc">small team</a>.</p></div></main>
  </body>
</html>
$ curl -s -o /dev/null -w '%{http_code} %{size_download} B\n' http://127.0.0.1:8792/media/work/one.jpg
/media/work/one.jpg -> 200 14 B
```

One deviation from §11.1's heading, stated rather than silently taken: the bytes are under
`media/`, not `assets/`. The render derives `/media/<key>.<ext>?v=…`, so a file under `assets/`
would make every image on every page a 404. `sitemap.xml` is emitted only when the caller
supplies an origin — a relative `<loc>` is not a sitemap, and omitting it beats shipping a
broken one.

## 6 — Determinism: byte-identical at one clock, one line at two

Three exports at `2026-10-20T12:00:00.000Z` and three more at `13:00:00.000Z`:

| target | first tree | second at the same clock | +1 h |
|---|---|---|---|
| static | `de33dff92a26e0fe66173a00cd5c5c840963707acdf0e973846f5f77ac26bcef` | **identical** | `b77ced968295aae8a5d0e5103e0bd09088b63bf455fc9289976bb5d41b270fa6` |
| astro | `9dda7f78e993d59ac2136b795abc6afa2c566ab4928422c00ff11cd702fae67a` | **identical** | `9a80e6591f318c9586b901f42d2f938e807bc24b3d8beed17a01c24190032de0` |
| cms | `42fd728d5b53838d619224b74a75a38cf23e9a73afd12d550b3b7d140aaf1859` | **identical** | `6c93d7a11fbc189ace708add2dc83d0ca02e9a8d1d49dd75191d885ac61e6f11` |

`tree_sha256` is `hashTree()`: sha256 over `path\0kind\0sha256\n` for every path, sorted — a
symlink hashes its **target string**, so two trees whose links differ but resolve alike cannot
hash equal. A second, independent check with the shell agrees:

```
$ (cd out/static && find . -type f -o -type l | sort | xargs shasum -a 256 | shasum -a 256)
9937802aa2fe3a63595ae43ead8c5947150bc728264ca9374a56b84532fef2b1   (both runs)
```

The second clock differs in exactly the declared places:

```
$ diff -rq static static-later
Files static/EXPORT-NOTES.md and static-later/EXPORT-NOTES.md differ
$ diff -rq astro astro-later
Files astro/EXPORT-NOTES.md and astro-later/EXPORT-NOTES.md differ
$ diff -rq cms cms-later
Files cms/BUNDLE.json and cms-later/BUNDLE.json differ
Files cms/EXPORT-NOTES.md and cms-later/EXPORT-NOTES.md differ

$ diff static/EXPORT-NOTES.md static-later/EXPORT-NOTES.md
5c5
< exported_at: 2026-10-20T12:00:00.000Z
---
> exported_at: 2026-10-20T13:00:00.000Z

$ diff cms/BUNDLE.json cms-later/BUNDLE.json
3,4c3,4
<   "created_at": "2026-10-20T12:00:00.000Z",
<   "export_now": "2026-10-20T12:00:00.000Z",
---
>   "created_at": "2026-10-20T13:00:00.000Z",
>   "export_now": "2026-10-20T13:00:00.000Z",
149c149
<       "sha256": "8d7495975e2187dd4ee532ec920d3bb493bcde2c2c4a16f0211025c8a030eae6",
---
>       "sha256": "032f71411ba2e151da40362c61cc5f72e060545283463542506a27ce82fa07d3",
```

That last line is the manifest's own hash of `EXPORT-NOTES.md`, which *is* the declared
timestamp's file — the one consequence the report should name rather than let a reader find.
D1/D2 assert the file set, `D3` asserts every file **and directory** mtime is pinned to
`SKW_EXPORT_NOW` (a tree whose mtimes drift is not byte-identical under `tar` or `rsync -a`),
and `D4` refuses a `SKW_EXPORT_NOW` that is not UTC ISO 8601.

## 7 — The shared-path proof, by mutation

The gate must be able to fail when the *product* breaks, not only when the exporter does. One
line in `app/render/body.ts`:

```diff
-  return renderBody(db, document);
+  return document;  // MUTATION: skip the shared render
```

| gate | before | mutated | after revert |
|---|---|---|---|
| `test/export-targets.test.ts` T0 (the **served** page) | ok | **not ok** — `the product: the image lost its derived URL` | ok |
| … T1 (static tree) | ok | **not ok** — `static: the image lost its derived URL` | ok |
| … T2 (astro build) | ok | **not ok** — `astro: the image lost its derived URL` | ok |
| … T3 (bundle boot) | ok | **not ok** — `bundle: the image lost its derived URL` | ok |
| `test/roundtrip.test.ts` RT-2 (`renderBody` called directly) | ok | **ok, 6/6** | ok |

**A finding about the gate itself, on the record.** On the first attempt only T0 and T1 went
red; T2 and T3 stayed green, because they compared the trees to the live site and the site had
degraded *identically*. Byte-equality between targets cannot see a fault the shared path gives
all of them. Each target's gate now also asserts the content on the bytes it served
(`assertRendered()`), and the table above is the second measurement. The roundtrip gate staying
green is the other half of the proof: the mutation is in the shared projection, not in
`renderBody()`.

## 8 — §16 S4 rows: covered, and not

| row | state |
|---|---|
| the three targets come from one generator and one projection | **covered** — P7, identical `projection_sha` in all three trees |
| two exports at one `SKW_EXPORT_NOW` byte-identical; at two clocks not | **covered** — D1/D2 |
| a `free` parameter in a link refuses with exit 22 | **covered** — P4 + the CLI's exit mapping |
| a `cp`-built bundle fails `--verify` and a `VACUUM INTO` one passes | **half** — the writer uses `VACUUM INTO` and the bundle passes; the `cp` fixture is `test/bundle-verify.test.ts`'s, unchanged |
| no bundle contains `control.db`, `-wal`, `-shm`, `content/protected/wm/`, `content/sources/` | **covered** for a real bundle — T4 |
| the CSP header is byte-identical in all three targets | **not done** — no target emits a CSP header yet; it is a shell change plus one assertion, and it belongs with the nginx snippet S4c generates |
| a page whose shell is unknown is `422` at publish | not this slice (S4a/publish) |
| install ≤ 5 min, plugin matrix, `asset_key` delete blocked | S4c |

## 9 — What S4c builds first

1. **`install.sh` against this bundle, end to end.** The bundle now carries everything the
   script reads (`schema/control.sql`, `schema/control.seed.json`, `tools/`, `nginx/`,
   `snippets/`, `docker-compose.yml`); nothing has run it. The first thing S4c should do is
   `./install.sh --no-compose` on a clean temp dir and assert exit 0, a `control.db` at
   `control.sql`'s version (**4**, not 3), the seeded tenant, a `0600` enrolment file and
   `bundle_verify` being **reached** — `install.sh` runs `tools/bundle_verify.mjs` from the
   bundle root, and until now no bundle existed for that branch to fire on.
   **Named while writing this:** `data/control.seed.json` still says `"schema_version": 3`
   while `schema/control.sql` declares `PRAGMA user_version = 4`, and nothing reads either
   (`seed_control.mjs` and `install.test.ts` both ignore it). It is inert today and a trap the
   first time somebody makes the install refuse a seed for the wrong version.
2. **The plugin runner**, because `planCms()` ships `plugins: []` unconditionally and refuses
   nothing: a tenant with a row in `cms_plugin_installed` would export a bundle whose `p_*`
   tables exist and whose code does not. That refusal does not exist yet, and it must.
3. **The CSP header**, identical in the three targets — the one S4 row this slice leaves open,
   and now cheap: one string in `renderDocument()`, one in the nginx snippet, one assertion.
4. **Disk (`SKW_E_EXP_INSUFFICIENT_DISK`) and a concurrent writer** (`NOT_QUIESCENT` under real
   contention). Both code paths exist; neither has been driven by a fixture.

## Appendix — reproducing

```bash
# the three gates
node --test --test-concurrency=1 test/export-projection.test.ts
node --test --test-concurrency=1 test/export-targets.test.ts        # builds the Astro tree
node --test --test-concurrency=1 test/export-determinism.test.ts

# a real site, then the operator's command
TMPDIR=$PWD/scratch/s4b node scratch/s4b/demo.mts
for t in static astro cms; do
  node app/cli/export.ts --target $t --tenant acme --out scratch/s4b/demo/out/$t \
    --data-dir scratch/s4b/demo/data --origin https://acme.test --now 2026-10-20T12:00:00.000Z
done
node tools/bundle_verify.mjs --bundle scratch/s4b/demo/out/cms

# the gated refusal, at the command
node app/cli/export.ts --target static --tenant acme --out /tmp/refused \
  --data-dir scratch/s4b/demo-gated/data --now 2026-10-20T12:00:00.000Z   # exit 21, nothing written
```

`scratch/s4b/` holds the demo data (`demo/`), the refused variant (`demo-gated/`), the three
trees and their same-clock/second-clock copies (`demo/out/*`, `*-b`, `*-later`), the two
document probes (`probe-serve.mts`, `probe-plain.mts`), the mutation log
(`mutation-targets.log`), and `make-test-final4.log`.

*Uncommitted by instruction.*
