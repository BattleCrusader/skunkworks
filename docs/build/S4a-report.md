# S4a report — the editor, driven in a browser: the registry as data, the save path, the fixpoint, and what GrapesJS does to the bytes

**Closes:** S4a items 0–4 (leak gate, registry as data, editor page, save path, fixpoint) and
this run's item 5, the browser round trip — plus the two browser proofs the brief asked for
(an unregistered `data-gjs-type` refused with its code, and the media picker writing a key).
**Tree:** `11daa67` + this working tree, **uncommitted**, as instructed. **No product file was
modified in this run**: `git status --short` is `?? docs/build/S4a-report.md` and
`?? scratch/s4a/` — this report and the harness, nothing else.
**Gate:** `make test` **458/458, 0 failed, 0 skipped, RC=0**, `verify-dist 6/6`,
`verify-no-leak: clean — 0 skw-* containers, 0 skw-* networks`, node suite **67.8 s**
(the final run, §10; the run before it was 85.4 s on the same box with the same counts).

| # | Item | Verdict | § |
|---|---|---|---|
| 0 | the leak gate, with its own negative control | **green** — 0 containers, 0 networks, and the control's probe is named | §1 |
| 1 | the registry as data (v4, editor half) | **green** — 10/10 cases | §2 |
| 2 | the editor page over the wire | **green** — 7/7 cases | §3 |
| 3 | the save path over the wire | **green** — 7/7 cases | §4 |
| 4 | the fixpoint over the 9 fixtures | **green** — 9/9, 6 byte-identical at pass 1 | §5 |
| 5 | **the editor driven in a real browser, per component** | **10/10 survived** their own round trip — and one defect the HTTP tests cannot see: every stored body carries the canvas `<body>` wrapper (**F1**) | §6 |

The brief calls the slice five items. The repo's own labels run `ITEM 0` (leak gate) and
"item 2 and 3" (the editor page and the save route) in the test headers; the fixpoint is the
SDS §10.3 acceptance criterion and sits between them. This report therefore carries six rows
and names, for each, where its number comes from, rather than inventing a fifth that would
have hidden one of them.

---

## 1 — ITEM 0: the leak gate

`test/container-leak.test.ts` is the in-suite half (a pure function over `docker ps` output);
`scripts/leak-gate.mjs --self-test` is the half that sees a leak left by a file that has
already finished, which is why it runs **last** in `verify` and not inside the node suite.

```
$ make test                      (verify-no-leak is the last target; RC=0)
verify-no-leak: auditing the daemon for skw-* (before: 0 container(s), 0 network(s))
  negative control: created skw-leak-probe-67296 and skipped its teardown — the audit names it (red, as required)
  negative control: probe removed, audit clean again
verify-no-leak: clean — 0 skw-* containers, 0 skw-* networks
```

The negative control is the whole gate: a matcher that matched nothing would read as a tidy
daemon. It creates a container named `skw-leak-probe-<pid>`, skips its teardown, requires the
audit to name it, removes it, and requires clean again. Checked by hand after the run:

```
$ docker ps -a --filter 'name=skw-' --format '{{.Names}}' | wc -l
0
$ docker network ls --filter 'name=skw-' --format '{{.Name}}' | wc -l
0
```

The in-suite half, on its own:

```
$ node --test --test-concurrency=1 test/container-leak.test.ts
ok 1 - L1 — the audit names every skw-* container and network, and nothing else
ok 2 - L2 — the negative control: a container whose teardown was skipped is reported
ok 3 - L3 — a clean daemon reports zero, so the gate can be green without being blind
# tests 3   # pass 3   # fail 0   # skipped 0
```

## 2 — ITEM 1: the registry as data

`schema/component-registry.json` v4 is the source; `cms_component_registry` is upserted from
it at boot; `app/editor/registry.ts` is the parser and the three projections (`palette`,
`typeDefinitions`, `registryCss`). The cases that matter are the refusals, because each one is
silent otherwise (§10.2a).

```
$ node --test --test-concurrency=1 test/editor-registry.test.ts
ok  1 - R1 — the palette is generated: a new registry entry appears with no other edit
ok  2 - R2 — the shipped registry is one entry per component, type === name, one css rule each
ok  3 - R3 — the palette keeps registry order and groups categories in first-seen order
ok  4 - R4 — a block whose html root does not carry its own data-gjs-type is refused
ok  5 - R5 — a type that is one of GrapesJS's own is refused at boot, not discovered at save
ok  6 - R6 — an editable field that does not exist in the html is refused
ok  7 - R7 — allowed_children must name a registered, non-shell component
ok  8 - R8 — §6.3's two list CHECKs, restated: [data-repeat] and a clamp
ok  9 - R9 — typeDefinitions re-emit the lock, which is what keeps a type registered across a save
ok 10 - R10 — the stylesheet is the registry's rules, in registry order
# tests 10   # pass 10   # fail 0   # skipped 0
```

## 3 — ITEM 2: the editor page, over the wire

`test/admin-editor.test.ts` goes through `buildApp` on a real socket with a real session and
the real CSRF header, because the failure this slice is most likely to have is "the route is
not wired", not "the module is wrong".

```
$ node --test --test-concurrency=1 test/admin-editor.test.ts
ok 1 - E1 — the editor page carries the generated palette, in registry order, and the vendored bundle
ok 2 - E2 — the bundle is served from this origin, and it is GrapesJS
ok 3 - E3 — a page whose body names an unregistered type is refused at load, with the code
ok 4 - E4 — the save route writes the row and the fixpoint holds through HTTP
ok 5 - E5 — the picker writes a key and never a URL; an unknown key is refused
ok 6 - E6 — the editor's writes are behind D28: no CSRF token, no write
ok 7 - E7 — every fixture page saves over HTTP and reloads to the same bytes
# tests 7   # pass 7   # fail 0   # skipped 0
```

E1's assertions are the ones the browser later confirms independently: 10 palette entries, in
registry order, six categories (`Structure`, `Text`, `Media`, `Commerce`, `Data`,
`Interactive`), `boot.types.length === 10`, and the page is data + two external scripts with no
inline script.

## 4 — ITEM 3: the save path, over the wire

```
$ node --test --test-concurrency=1 test/editor-save.test.ts
ok 1 - S1 — a first save writes one page row and one revision, with body_sha over the stored bytes
ok 2 - S2 — a second save increments rev and appends a revision; the bytes are canonical both times
ok 3 - S3 — the unregistered type: GrapesJS strips it, so the refusal runs before the load
ok 4 - S4 — nesting is the registry's rule: a component inside a parent that does not allow it is refused
ok 5 - S5 — D17: the picker writes a key, the body stores no URL, and the render derives it
ok 6 - S6 — a list component stores its items as rows and reloads in the same order
ok 7 - S7 — §10.6: a hand-managed page is read-only, and the refusal says so
# tests 7   # pass 7   # fail 0   # skipped 0
```

The order in `savePage()` is the design — analyse → canon → **analyse again** → write, one
transaction with a revision row — and the second analyse is what catches a serializer that
dropped the lock. §7 below is the same three refusals measured through a browser instead of
through the route.

## 5 — ITEM 4: the fixpoint, nine fixtures

The gate is `stored(load(stored(load(page)))) == stored(load(page))`, i.e. the *stored* bytes,
not the editor's two passes — the canvas paints a placeholder `src` and the save path removes
it (D17), so the weaker statement would pass on a page that cannot be re-saved.

```
$ node --test --test-concurrency=1 test/roundtrip.test.ts
ok 1 - RT-0 — the corpus is nine pages, and every shipped block is exercised by one of them
ok 2 - RT-1 — all nine fixtures reach the fixpoint on stored bytes, and lose no component on the way
ok 3 - RT-11 — the negative control: an editor missing one type definition reddens RT-1, naming the page and the type
ok 4 - RT-12 — an unregistered type in a stored body is refused by the gate, with a code
# tests 4   # pass 4   # fail 0   # skipped 0
```

The per-fixture measurement RT-1 emits (reproduce with `node scratch/s4a/fixture-stability.mts`,
which calls the gate's own `twoPasses`):

| fixture | components | authored | stored | byte-stable at pass 1 |
|---|---|---|---|---|
| `about.html` | figure + prose | 369 B | 370 B | yes |
| `contact.html` | copy-email + form | 484 B | 521 B | yes |
| `embed.html` | embed + prose | 228 B | 227 B | yes |
| `gallery.html` | gallery | 384 B | 356 B | yes |
| `index.html` | cta + hero + list | 1190 B | 1249 B | **no** |
| `legal.html` | prose | 150 B | 149 B | yes |
| `post.html` | figure + list + prose | 686 B | 710 B | **no** |
| `pricing.html` | cta + download-button + prose | 532 B | 505 B | **no** |
| `services.html` | cta + gallery + prose | 585 B | 566 B | yes |

`6/9` byte-identical at pass 1, `3/9` differ — and the three are exactly the pages with a
`list` (`index`, `post`: the `data-item-position` stamp) and the page with a
`download-button` (`pricing`: D17 drops the `href` on an element that names a key). The
measurement is printed, not asserted, because §10.3 says an empty diff on pass 1 is not the
gate; the gate is that the *second* pass changes nothing, and all nine do that.

RT-11 is the half a fixpoint cannot see: a save that silently drops a component reaches a
fixpoint immediately. Remove one type definition and RT-1 reddens naming `index.html` and
`hero`; restore it and the page is a fixpoint again.

---

## 6 — ITEM 5: the editor driven in a real browser

### 6.1 How it is driven

| | |
|---|---|
| engine | **Google Chrome for Testing 151.0.7922.34** (Chromium build shipped with Playwright 1.62.0), headless |
| app | the real `buildApp` on a real socket, one tenant (`acme`), a real operator (`owner@acme.test`, argon2id, TOTP) |
| admin origin | `http://localhost:<port>` — `SKW_ADMIN_ORIGIN` moved to `localhost` so the browser will hold a `Secure` `__Host-sk-sess` cookie (Chrome treats `http://localhost` as trustworthy); the app is otherwise untouched |
| login | the real form: `POST /admin/login` with email, password and a TOTP computed from the seeded secret |
| insert | a real click on the palette button the boot script builds (`#skw-blocks button[data-type=…]`) |
| save | `window.skwSave()` — the product's own function, not a hand-built request |
| compare | `SELECT body_html FROM cms_page WHERE path = ?` after each save — the **stored bytes** |

The harness is `scratch/s4a/browser-server.mts` (the app + the operator) and
`scratch/s4a/browser-drive.py` (Playwright). No jsdom: the measurement is Blink's parser,
GrapesJS 0.23.8 and the vendored bundle, which is the only way any of this can be seen.

```bash
TMPDIR=$PWD/scratch/s4a node scratch/s4a/browser-server.mts &   # listening on http://localhost:<port>
/Users/cyberdeth/.hermes/installs/b86edf720dadbbe8/environments/8a335f5c0cb24326a033f193f348175b/venv/bin/python \
  scratch/s4a/browser-drive.py                                  # writes scratch/s4a/evidence.json
```

### 6.2 Per component

Flow per component: create a row at `/c/<type>` → open it in the editor → click the palette
button → save (**B1**) → reload `?page=<id>` → save again (**B2**) → compare the two rows.

| component | kind | B1 | sha256/8 | B2 | sha256/8 | lock after | verdict |
|---|---|---|---|---|---|---|---|
| `hero` | block | 476 B | `f9a61b93` | 476 B | `f9a61b93` | `hero`, 4 `data-prop` | **survived** |
| `prose` | block | 113 B | `3b451074` | 113 B | `3b451074` | `prose`, 1 | **survived** |
| `figure` | block | 210 B | `5aeda7b7` | 210 B | `5aeda7b7` | `figure`, 2 | **survived** |
| `gallery` | block | 188 B | `1c4d9a41` | 188 B | `1c4d9a41` | `gallery`, 1 | **survived** |
| `download-button` | block | 205 B | `b6214134` | 205 B | `b6214134` | `download-button`, 2 | **survived** |
| `cta` | block | 206 B | `2c2dd66a` | 206 B | `2c2dd66a` | `cta`, 2 | **survived** |
| `form` | block | 352 B | `9155b74e` | 352 B | `9155b74e` | `form`, 1 | **survived** |
| `embed` | block | 141 B | `0f3b0285` | 141 B | `0f3b0285` | `embed`, 1 | **survived** |
| `list` | list | 385 B | `06dc03fa` | 385 B | `06dc03fa` | `list`, `data-item-position` | **survived** |
| `copy-email` | island | 244 B | `f6f703b9` | 244 B | `f6f703b9` | `copy-email`, `data-prop` | **survived** |

**10 of 10 draggable components survived**: the palette's block reached the database, kept its
`data-gjs-type`, kept every `data-prop` the registry declares, and a reload-then-save produced
byte-identical bytes. The revision rows say the same thing without going through the evidence
file:

```
$ sqlite3 …/site.db "SELECT p.path, r1.rev, r2.rev, r1.body_html = r2.body_html, length(r1.body_html)
  FROM cms_page p JOIN cms_page_revision r1 ON r1.page_id=p.id AND r1.rev=1
                     JOIN cms_page_revision r2 ON r2.page_id=p.id AND r2.rev=2 ORDER BY p.id;"
/c/hero|1|2|1|476
/c/prose|1|2|1|113
/c/figure|1|2|1|210
/c/gallery|1|2|1|188
/c/download-button|1|2|1|205
/c/cta|1|2|1|206
/c/form|1|2|1|352
/c/embed|1|2|1|141
/c/list|1|2|1|385
/c/copy-email|1|2|1|244
```

The four shells (`page`, `landing`, `post`, `index`) are **not** in that table on purpose: they
are `kind: "shell"`, they have no palette entry and no `html`, and the editor cannot insert
one. They are out of scope for a per-component insert, and §9 says so.

### 6.3 What changed relative to the registry's snippet — and why that is not a defect

"Survived" here means *the lock survived and the bytes are a fixpoint*. It does not mean the
stored bytes equal the registry's `html` string, and the report would be dishonest if it
implied that. The differences, measured:

| component | difference | why |
|---|---|---|
| all ten | the body is wrapped in `<body>…</body>` | **F1 — a defect.** See 6.4. |
| `hero`, `figure`, `gallery` | `alt=""` → `alt` | GrapesJS drops an empty attribute value; HTML-equivalent |
| `download-button` | `href="/d/vault-book"` on the `<a data-asset-key="vault/book">` is **dropped** | `assertAssetKeys()` (D17): on an element that names a key, `src`/`srcset`/`href` are canvas artefacts. The renderer derives the URL from the key — intended |
| `list` | `data-item-position="0"` added to the `[data-repeat]` row | D35: list items stay in `body_html`, and the position is *recorded* so a reload cannot reorder them |
| `copy-email` | `data-props="{&quot;address&quot;…}"` → `data-props='{"address"…}'` | GrapesJS re-quotes the attribute; the JSON is unchanged |
| all ten | attribute order (`data-gjs-type` first, then `class`, then `data-*`) | `canon()`'s fixed order (§10.3) |

### 6.4 F1 — the stored body is `editor.getHtml()`'s `<body>` wrapper

Every one of the ten pages, and the picker page, stores a document that starts with `<body>`:

```
$ sqlite3 …/site.db "SELECT count(*) FROM cms_page WHERE path LIKE '/c/%' AND body_html LIKE '<body>%';"
11          -- of 11 pages under /c/ (ten components + the picker page)
```

`canon.ts` already has the function that strips it, and its own comment says why:

```ts
// app/editor/canon.ts:91-95
// Strip the canvas wrapper. `editor.getHtml()` answers `<body>…</body>`; a fragment is
// what `cms_page.body_html` stores.
export function unwrapBody(html: string): string { … }
```

…and the only caller in the tree is the **test** helper:

```
$ grep -rn unwrapBody --include=*.ts . | grep -v node_modules     (collapsed, annotated)
app/editor/canon.ts:22                 a comment saying why
app/editor/canon.ts:96                 the function
test/editor-canon.test.ts:77,78,80     C5, the unit test
test/helpers/grapes.ts:100             return unwrapBody(editor.getHtml());
```

`savePage()` never calls it (`app/editor/save.ts:64–77`: `analyseBody` → `canon` →
`analyseBody` → write), and `window.skwSave` sends `editor.getHtml()` verbatim
(`app/admin/editor.ts:272`). So the product stores the wrapper while the fixpoint gate's
simulated editor strips it — **the gate and the product disagree by one line**, which is
exactly why `make test` is 9/9 green and every browser-saved page is not a fragment.

The consequence, at the render: `app/render/components/shells/page.astro:30` is
`<main set:html={page.bodyHtml} />`, so a saved page renders as `<main><body>…</body></main>`.
Browsers hoist the children and it *looks* fine; the static exporter writes the bytes it was
given, and any consumer that parses `body_html` as a fragment (D35 says the exporters do) gets
a `<body>` element where a block should be.

**Not fixed here.** The brief for this run is evidence and a report; weakening or silently
patching the save path would have made the finding disappear from the record. The fix is one
line at the top of `savePage()` (`unwrapBody(input.html)` before the first `analyseBody`) plus
a case that posts the wrapper — E4 posts a bare fragment today, so it cannot see this.

### 6.5 The canvas

Screenshots of all ten are in `scratch/s4a/shots/`. Two things they show, neither of which is
in the acceptance criteria and both of which are real:

- the palette renders the registry's labels under the registry's categories, in registry
  order, and a palette click puts the block in the canvas (hero: headline, subtitle, image
  placeholder, button; list: the card, the `Read` link and the `No posts yet.` empty state);
- the canvas is **an iframe** (`#gjs` holds two: `iframe.gjs-frame` and `iframe.frame`), and
  `boot.css` is written into the *editor page's* `<head>`, not into that frame — so the canvas
  is unstyled even though `editorBootPayload` carries the page's stylesheet "so the canvas is
  not unstyled". See **F3**.

---

## 7 — The two refusals, in the browser

### 7.1 An unregistered `data-gjs-type` in a stored body is refused at load

`/legacy` holds `<div data-gjs-type="carousel"><p>slides</p></div>`. Navigating to it in the
browser:

```
GET /admin/t/acme/editor?page=2   ->  422
{"error":{"code":"SKW_E_RT_COMPONENT_UNKNOWN",
          "message":"no component is registered for data-gjs-type=\"carousel\"",
          "detail":{"tag":"div","type":"carousel",
                    "known":["hero","prose","figure","gallery","download-button",
                             "cta","form","embed","list","copy-email"]}}}

document.querySelector('#gjs')   ->  null
typeof window.grapesjs           ->  "undefined"
```

The refusal happens before the editor exists: no canvas, no bundle, nothing for GrapesJS to
strip. This is the ordering the design claims and the browser is the only place it is
observable as an ordering rather than as a status code.

### 7.2 An unregistered `data-gjs-type` in the bytes the client sends is refused at save

From the editor page, the same document posted to the product's save route:

```
POST /admin/t/acme/editor/save  ->  422  SKW_E_RT_COMPONENT_UNKNOWN  detail.type = "carousel"
SELECT count(*) FROM cms_page WHERE path = '/c/unregistered'  ->  0
```

The code, not a 400, not a silent write.

### 7.3 What GrapesJS does when it *does* parse it — and the one hole left

This is the measurement the whole design rests on, taken in the browser:

```
before  49 B  <div data-gjs-type="carousel"><p>slides</p></div>
after   37 B  <body><div><p>slides</p></div></body>
console: warning: Component type 'carousel' not found {attrs: Object, options: Object}
save    -> 200, stored: <body>\n  <div><p>slides</p></div>\n</body>
```

The lock is **gone** after the parse: `data-gjs-type` is not in the output at all, and the
block is an anonymous `div`. So a document pasted *into a running canvas* is not refused —
by construction, because the evidence is destroyed before the server sees it. The gate is at
the load path and at the save route, and those two are where it can be. **F2** records the
consequence honestly: an operator who pastes `<div data-gjs-type="carousel">…</div>` into the
canvas sees a plain div, saves it, and gets a 200 with a body that has no component in it.

### 7.4 The media picker writes a key, never a URL (D17)

`figure`, selected by a click in the canvas, so the settings panel is the registry's:

```
#skw-settings innerText   ->  "Image\nsrc\nbanner/home\ncaption"     (the asset field, current key)
GET  /editor/media.json   ->  200  {assets:[{key:"banner/home",…},{key:"gallery/one",…}]}
POST /editor/pick         ->  200  {key:"gallery/one",
                                    previewUrl:"/media/gallery/one.jpg?v=cdcdcdcd",
                                    html:"…data-asset-key=\"gallery/one\"…"}
save                      ->  200
```

Stored bytes after the pick:

```html
<body>
  <figure data-gjs-type="figure" class="figure" data-ratio="4:3">
    <img data-asset-key="gallery/one" data-prop="src" alt />
    <figcaption data-prop="caption">Caption</figcaption>
  </figure>
</body>
```

- `storedHasKey  = True` — the key the picker chose (`gallery/one`) is what the row names; it
  replaced the `banner/home` the block was inserted with, so the picker *wrote* it.
- `storedHasMediaUrl = False` — no `/media/` anywhere in `body_html`.
- `previewUrl` **was** a URL (`/media/gallery/one.jpg?v=cdcdcdcd`) and was **not** stored: the
  URL exists only in the response that paints the canvas. That is D17 in one line.

---

## 8 — Findings

| # | Finding | Severity | Evidence |
|---|---|---|---|
| **F1** | Every editor-saved page stores `editor.getHtml()`'s `<body>…</body>` wrapper in `cms_page.body_html`; `unwrapBody()` exists and is wired into the **test helper**, not the save path. `make test` cannot see it: E4 posts a bare fragment and RT-1's editor strips the wrapper. | **Major** (the primary authoring path) | §6.4 — 11/11 rows, `canon.ts:96` vs `save.ts:64` vs `grapes.ts:100` |
| **F2** | A document pasted **into a running canvas** with an unregistered `data-gjs-type` is not refused — GrapesJS strips the lock first (49 B → 37 B) and the save stores a component-less `div` with a 200. The gate holds at load and at the save API, and cannot hold here. | **Major, by construction** — needs a product decision (a canvas-level `parser` refusal, or accept it and say so in §10.5) | §7.3 |
| **F3** | The canvas is an iframe (two of them) despite `editor.ts:141` saying "no iframe, so the admin CSP applies to it"; and `boot.css` is injected into the editor page's head, so the canvas is unstyled although the payload carries the page's stylesheet "so the canvas is not unstyled". | Minor (comments and UX; CSP still applies to a `srcdoc` frame by inheritance) | §6.5, `scratch/s4a/shots/hero.png` |
| **F4** | The picker's `previewUrl` is discarded by the boot script (only `button.textContent` is updated), so an `<img>` that names a key paints as a placeholder box in the canvas even immediately after a successful pick. D17's cost, unmitigated in the editor. | Minor (operator cannot see the image they picked without saving and previewing) | §7.4, `scratch/s4a/shots/hero.png` |

F1 and F2 are the two the browser found and the HTTP suite could not. Neither is fixed in
this run, on instruction; F1 has a one-line fix named in §6.4.

## 9 — What is not covered

An undriven thing is **not covered**, not passed. The ten draggable components were driven;
these were not:

1. **Drag-and-drop as a gesture.** The palette *click* was used (the same `item.content`
   insert path the boot script wires), not an HTML5 `dragstart`/`drop` across the two frames.
   A drop that lands in a nested container would exercise `allowed_children` in the canvas;
   `S4` covers the nesting rule at the save path only.
2. **The four shells** (`page`, `landing`, `post`, `index`). Not palette items, not insertable,
   no `html`; their behaviour is the renderer's, not the editor's.
3. **The settings panel's text fields.** The asset field was driven end-to-end (§7.4); typing
   into `title`/`caption` and saving was not, so the `input` handler at `editor.ts:230` is
   unexercised in a browser.
4. **The rendered page.** The `<body>` wrapper's effect inside `<main>` (F1) is stated from
   `page.astro:30`; the rendered output of a saved page was **not** opened in a browser.
5. **`list` with data**: zero rows, several rows, `data-limit` clamping and `data-truncated`
   are the SSR loop's contract (S3/S4 render gates), not driven here. The stored shape and
   the `data-item-position` stamp are.
6. **One engine.** Chromium 151 only. GrapesJS's serialiser is engine-independent in
   principle and is not asserted to be.
7. **A native dialog.** `window.prompt` was replaced with a constant so the run would not
   block on a modal; everything after it (the `POST`, `applyPick`, `setComponents`, the save)
   is the real path.
8. **Two operators on one page** (rev conflict), and **`managed_by='hand'`** opened in the
   canvas in a browser — S7 covers the refusal at the module level only.

## 10 — The gate, after the last edit

```
$ make test
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok
…
# tests 458
# suites 10
# pass 458
# fail 0
# skipped 0
…
verify-dist: 6/6 passed — the artefact on disk is the one asserted
verify-no-leak: auditing the daemon for skw-* (before: 0 container(s), 0 network(s))
  negative control: created skw-leak-probe-67296 and skipped its teardown — the audit names it (red, as required)
  negative control: probe removed, audit clean again
verify-no-leak: clean — 0 skw-* containers, 0 skw-* networks
RC=0
```

**458/458, 0 failed, 0 skipped**, `verify-dist 6/6`, the leak gate clean *and* its control red
where it must be. `SKW_ALLOW_SKIP` was never set; no gate was weakened; no component was
modified to make it survive.

---

## Appendix A — the stored bytes, per component

`B1` is the row after the first save (insert from the palette); `B2` is the row after
reloading `?page=<id>` and saving again. Both are pasted from
`scratch/s4a/evidence.json`, which the driver wrote from `SELECT body_html`: where a block
says "B1 = B2" the two strings are equal and the sha256 of both is printed. The full 64-hex is
in that file.

**hero** — B1 = B2, 476 B, `sha256:f9a61b93…`
```html
<body>
  <section data-gjs-type="hero" class="hero" data-align="left">
    <div class="hero__inner">
      <h1 class="hero__title" data-prop="title">A headline that says what this is</h1>
      <p class="hero__subtitle" data-prop="subtitle">One sentence about who it is for.</p>
      <img class="hero__image" data-asset-key="banner/home" data-prop="image" alt />
      <a class="btn btn--primary" data-prop="cta" href="/contact">Talk to us</a>
    </div>
  </section>
</body>
```

**prose** — B1 = B2, 113 B, `sha256:3b451074…`
```html
<body>
  <div data-gjs-type="prose" class="prose"><p data-prop="body">Write the paragraph here.</p></div>
</body>
```

**figure** — B1 = B2, 210 B, `sha256:5aeda7b7…`
```html
<body>
  <figure data-gjs-type="figure" class="figure" data-ratio="4:3">
    <img data-asset-key="banner/home" data-prop="src" alt />
    <figcaption data-prop="caption">Caption</figcaption>
  </figure>
</body>
```

**gallery** — B1 = B2, 188 B, `sha256:1c4d9a41…`
```html
<body>
  <div data-gjs-type="gallery" class="gallery" data-columns="3">
    <figure class="gallery__item"><img data-asset-key="banner/home" data-prop="src" alt /></figure>
  </div>
</body>
```

**download-button** — B1 = B2, 205 B, `sha256:b6214134…`
```html
<body>
  <p data-gjs-type="download-button" class="download">
    <a class="btn" data-asset-key="vault/book" data-prop="href">
      <span data-prop="label">Download the book</span>
    </a>
  </p>
</body>
```

**cta** — B1 = B2, 206 B, `sha256:2c2dd66a…`
```html
<body>
  <aside data-gjs-type="cta" class="cta">
    <p class="cta__title" data-prop="title">Ready when you are.</p>
    <a class="btn" data-prop="target" href="/contact">Get in touch</a>
  </aside>
</body>
```

**form** — B1 = B2, 352 B, `sha256:9155b74e…`
```html
<body>
  <form data-gjs-type="form" class="form" data-form="contact">
    <label class="form__label">
      Email
      <input
        class="form__input"
        data-prop="email"
        name="email"
        placeholder="you@example.com"
        type="email"
      />
    </label>
    <button class="btn" type="submit">Send</button>
  </form>
</body>
```

**embed** — B1 = B2, 141 B, `sha256:0f3b0285…`
```html
<body>
  <div data-gjs-type="embed" class="embed">
    <p class="embed__label" data-prop="src">https://example.com/embed</p>
  </div>
</body>
```

**list** — B1 = B2, 385 B, `sha256:06dc03fa…`
```html
<body>
  <div data-gjs-type="list" class="list" data-limit="3" data-source="posts">
    <article class="card" data-item-position="0" data-repeat>
      <h3 class="card__title" data-bind-title="title">Post title</h3>
      <a class="card__link" data-bind-href-slug="slug" href="/blog/post">Read</a>
    </article>
    <p class="list__empty" data-empty>No posts yet.</p>
  </div>
</body>
```

**copy-email** — B1 = B2, 244 B, `sha256:f6f703b9…`
```html
<body>
  <button
    data-gjs-type="copy-email"
    class="island island--copy-email"
    data-island="copy-email"
    data-prop="address"
    data-props='{"address":"hello@example.com"}'
    type="button"
  >
    Copy email
  </button>
</body>
```
