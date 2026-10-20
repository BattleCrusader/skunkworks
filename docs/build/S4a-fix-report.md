# S4a-fix — F1 and F2 closed: the gate drives the product, the paste stops at the clipboard

**Closes:** S4a **F1** (the fixpoint gate measured a canonicalisation the product never
performed, so 11/11 stored rows carried the canvas `<body>` wrapper) and **F2** (a 49 B
document naming a type GrapesJS has no definition for was stripped *before* the server saw
it, and stored as a 37 B anonymous div with a 200).
**Tree:** `436d913` + this working tree, **uncommitted**, as instructed. Production changes:
`app/editor/save.ts`, `app/editor/paste.ts` (new), `app/admin/editor.ts`, `app/admin/routes.ts`,
`app/errors.ts`, `schema/error-codes.json`. Test changes: `test/roundtrip.test.ts`,
`test/helpers/grapes.ts`, `test/admin-editor.test.ts`, `test/editor-save.test.ts`,
`test/editor-paste.test.ts` (new), `test/error-codes.test.ts` (the code count, 75 → 76).
Harness: `scratch/s4a/paste-proof.py` and five probes, reusing `browser-server.mts`.
**Gate:** `make test` **468/468, 0 failed, 0 skipped, RC=0**, `verify-dist 6/6`,
`verify-no-leak: clean — 0 skw-* containers, 0 skw-* networks`. `SKW_ALLOW_SKIP` was never
set; no gate was weakened.

| # | Item | Verdict | § |
|---|---|---|---|
| F1 | the stored bytes are a fragment, and the gate now proves it through the save route | **closed** — 9/9 fixtures, red when reverted | §1 |
| F2 | the paste/import path refuses before GrapesJS parses; the save refuses a lockless body and an inventory mismatch | **closed** — 3 browser proofs + 2 route proofs | §2 |
| — | what S4b must assume about `body_html` | stated | §3 |
| — | F5, found while proving F2 | named, not fixed | §4.3 |

---

## 1 — F1: the gate, the save path, and the one canonicaliser

### 1.1 What was wrong

`savePage()` canonicalised `input.html` and wrote it. `window.skwSave` posts
`editor.getHtml()`, which is a `<body>…</body>` **document**. Nothing in the product ever
called `unwrapBody()`. The only caller in the tree was the round-trip gate's test helper:

```
$ grep -rn unwrapBody --include=*.ts --include=*.mts app test scratch
app/editor/canon.ts:96:export function unwrapBody(html: string): string { … }
app/editor/save.ts:21:import { canon, unwrapBody } from './canon.ts';   ← added by this fix
app/editor/save.ts:75:  const document = unwrapBody(input.html);       ← added by this fix
test/editor-canon.test.ts:77-80                                          the unit case
```

Before the fix the only production-adjacent caller was `test/helpers/grapes.ts:100`
(`return unwrapBody(editor.getHtml())`). The gate therefore compared two documents that had
both been stripped by a helper, while the route stored both unstripped. The gate was green
because it was measuring its own copy of the pipeline — the same shape of defect as a second
canonicaliser, and the reason §13 D21 asks for one path.

### 1.2 The fix, at both ends

**a. The save path owns the transformation.** `savePage()` unwraps first, then validates,
canonicalises, validates the canonical bytes and writes:

```ts
const document = unwrapBody(input.html);
if (/<body[\s>]/i.test(document)) { … SKW_E_RT_BODY_FORBIDDEN, detail.rule = 'body-document' … }
const analysing = analyseBody({ html: document, registry });
```

The guard matters: `unwrapBody` only strips a document that *is* one `<body>` at the root, so
`<html><body>…` would otherwise be stored as a second body inside the shell's `<main>`. It is
refused, with the code that already meant "this body is not allowed" and a `rule` that says
which rule. There is exactly **one** implementation of "strip the canvas wrapper" and it is
`canon.ts:96`, called from `save.ts:75`.

**b. The gate drives the production entry point.** `test/roundtrip.test.ts` no longer has a
`stored()` helper and no longer imports `canon` at all; the `analyseBody` it still uses is
only for the component multiset and the refusal case, never to produce the stored bytes. It:

1. loads the fixture into a real GrapesJS (jsdom, headless) — `openEditor()`;
2. posts the payload `window.skwSave` posts — `{id?, path, title, template, html:
   editor.getHtml(), css: editor.getCss(), components: inventory()}` — to
   `POST /admin/t/acme/editor/save` over a real socket, with the real session and CSRF header;
3. reads `bodyHtml` from the response — the bytes the server says it stored;
4. loads **those bytes** back into the canvas, posts again, and compares the two stored
   generations.

There is no canonicaliser in the test file. `test/helpers/grapes.ts` now returns
`editor.getHtml()` **verbatim** (`document()` → `{html, css, components}`, the `<body>` wrapper
included) because that is what the product posts; its own copy of the unwrap is gone. `pass1`
in `test/editor-save.test.ts` S3 (the "GrapesJS strips the lock" measurement) is now the raw
canvas document, which is the honest input to that measurement.

The gate asserts, per fixture: the stored component multiset equals the authored one; the
stored bytes contain no `<body`; the stored bytes begin with `<tag data-gjs-type="type"` for
the page's first component; the number of top-level elements is unchanged; the second stored
generation is byte-identical to the first; `canon` is idempotent on it.

```
$ node --test --test-concurrency=1 test/roundtrip.test.ts
ok 1 - RT-0 — the corpus is nine pages, and every shipped block is exercised by one of them
ok 2 - RT-1 — all nine fixtures reach the fixpoint on bytes the save route stored, and lose no component on the way
ok 3 - RT-13 — the stored bytes render inside the page shell as the fragment they are
ok 4 - RT-2 — the render derives the URL from the key, and a gated asset renders to its redeem path
ok 5 - RT-11 — the negative control: an editor missing one type definition reddens RT-1, naming the page and the type
ok 6 - RT-12 — an unregistered type in a stored body is refused by the gate, with a code
# tests 6   # pass 6   # fail 0
```

RT-13 is the "the rendered page still works" half: for every stored body,
`renderBody(db, stored)` produces no `<body>`, the shell's `<main>…</main>` holds exactly one
`<main>` and zero `<body>`, and the first rendered element is the same component the stored
bytes start with. RT-2 adds the D17 half (a gated asset renders to `/d/vault/rate-card`, a
public one to `/media/work/one.jpg?v=abababab`).

### 1.3 The revert goes red

`savePage()` reverted to the tree's version — `analyseBody({ html: input.html })`, no unwrap,
no guard — and the same gate, unchanged:

```
$ node --test --test-concurrency=1 test/roundtrip.test.ts      (fix reverted)
ok 1 - RT-0 — …
not ok 2 - RT-1 — all nine fixtures reach the fixpoint on bytes the save route stored, …
  error: 'about.html: the stored bytes are a document, not a fragment:
          "<body>\n  <div data-gjs-type=\"prose\" class=\"prose\">\n    <p da"'
not ok 3 - RT-13 — the stored bytes render inside the page shell as the fragment they are
  error: 'about.html: RT-1 did not store this page'
not ok 4 - RT-2 — the render derives the URL from the key, …
not ok 5 - RT-11 — the negative control …
# tests 6   # pass 2   # fail 4   (RC=1)
```

The failure is the wrapper itself, named with the page and the first 60 bytes — not a
mysterious diff. Restored, the same file is 6/6 green (§1.2). The reverted-vs-fixed stored
bytes for all nine fixtures, measured with `scratch/s4a/fixture-bytes.mts` (same input, same
canonicaliser, one line different):

| fixture | canvas doc B | stored B **reverted** | `<body`? | stored B **fixed** | `<body`? | first line, fixed |
|---|---|---|---|---|---|---|
| `about.html` | 767 | 399 | **yes** | 370 | no | `<div data-gjs-type="prose" class="prose">` |
| `contact.html` | 486 | 582 | **yes** | 521 | no | `<form data-gjs-type="form" class="form" data` |
| `embed.html` | 231 | 254 | **yes** | 227 | no | `<div data-gjs-type="embed" class="embed">` |
| `gallery.html` | 1556 | 381 | **yes** | 356 | no | `<div data-gjs-type="gallery" class="gallery"` |
| `index.html` | 1537 | 1314 | **yes** | 1249 | no | `<section data-gjs-type="hero" class="hero" d` |
| `legal.html` | 158 | 182 | **yes** | 149 | no | `<div data-gjs-type="prose" class="prose">` |
| `post.html` | 1069 | 753 | **yes** | 710 | no | `<div data-gjs-type="prose" class="prose">` |
| `pricing.html` | 519 | 544 | **yes** | 505 | no | `<div data-gjs-type="prose" class="prose">` |
| `services.html` | 1357 | 603 | **yes** | 566 | no | `<div data-gjs-type="prose" class="prose">` |

Fixed: **9/9** start with their own component's tag and contain no `<body>`; reverted:
**9/9** start with `<body>` and are 16–65 B larger (the wrapper plus the indentation Prettier
gives a document). The nine stored bodies are the same bytes the pre-fix *gate* was measuring
— which is why `make test` never saw it: the gate's numbers did not change, only the
producer's did.

### 1.4 The one route-level assertion

`E7` now asserts, for each of the nine fixtures posted over HTTP, that the response's
`bodyHtml` contains no `<body`. E4's input is already a fragment, so only a corpus-wide
assertion at the route can see the difference; before this fix, E7 accepted all nine
wrapped rows.

### 1.5 The per-component browser sweep, re-run against the fix

The S4a driver, **unmodified** (`scratch/s4a/browser-drive.py`: palette click → `window.skwSave`
→ reload `?page=<id>` → save again), writes every component and compares the stored bytes:

```
--- summary ---
hero             survived   fixpoint=True type=['hero'] props=['title','subtitle','image','cta']
prose            survived   fixpoint=True type=['prose'] props=['body']
figure           survived   fixpoint=True type=['figure'] props=['src','caption']
gallery          survived   fixpoint=True type=['gallery'] props=['src']
download-button  survived   fixpoint=True type=['download-button'] props=['href','label']
cta              survived   fixpoint=True type=['cta'] props=['title','target']
form             survived   fixpoint=True type=['form'] props=['email']
embed            survived   fixpoint=True type=['embed'] props=['src']
list             survived   fixpoint=True type=['list'] props=[]
copy-email       survived   fixpoint=True type=['copy-email'] props=['address']
failures: []
```

| component | S4a B1 (wrapped) | now | `<body`? | first bytes |
|---|---|---|---|---|
| `hero` | 476 B | **445 B** | no | `<section data-gjs-type="hero" class="hero"` |
| `prose` | 113 B | **96 B** | no | `<div data-gjs-type="prose" class="prose">` |
| `figure` | 210 B | **187 B** | no | `<figure data-gjs-type="figure" class="figu` |
| `gallery` | 188 B | **167 B** | no | `<div data-gjs-type="gallery" class="galler` |
| `download-button` | 205 B | **180 B** | no | `<p data-gjs-type="download-button" class="` |
| `cta` | 206 B | **183 B** | no | `<aside data-gjs-type="cta" class="cta">` |
| `form` | 352 B | **311 B** | no | `<form data-gjs-type="form" class="form" da` |
| `embed` | 141 B | **120 B** | no | `<div data-gjs-type="embed" class="embed">` |
| `list` | 385 B | **356 B** | no | `<div data-gjs-type="list" class="list" dat` |
| `copy-email` | 244 B | **209 B** | no | `<button` |

0 of 10 carry the wrapper; the picker's page is 187 B and also a fragment. The same run's
in-canvas measurement — `setComponents` with the 49 B payload, then save — which S4a recorded
as **200**, is now:

```
=== unregistered in CANVAS: 49 B -> 37 B: '<body><div><p>slides</p></div></body>'; save -> None
```

(`None` is the driver's `.get('bodyHtml')` on a refusal; the response is
`422 SKW_E_RT_BODY_FORBIDDEN`, "a page body with content must carry a registered component".)
`failures: []`, and the two 422s in that run's network log are the load-path refusal (E3's
fixture) and this one.

---

## 2 — F2: the paste, stopped at the clipboard

### 2.1 What S4a measured, and what the browser says now

S4a measured `editor.setComponents('<div data-gjs-type="carousel"><p>slides</p></div>')` and
reported 49 B → 37 B and a 200. Driving it again, the shape reproduces exactly, and two
things about the path are now on the record:

```
$ scratch/s4a/paste-proof.py
3. degraded save: 422 SKW_E_RT_BODY_FORBIDDEN {"page": "/degraded-from-canvas", "rule": "no-component"} rows=0
4. raw import: 49 B -> 37 B, lock kept: False
   out: <body><div><p>slides</p></div></body>
```

- `setComponents` is the call that parses; it is the **import** path, and in this build the
  only callers are the boot script's load (server-validated) and the media picker
  (`applyPick()` rewrites one attribute and does **not** re-validate the document the client
  posted). There is no operator-facing paste target: the canvas body is not contenteditable
  (`body.isContentEditable === false`, `contenteditable` absent), and GrapesJS's rich-text
  editor — the only editable surface, opened by double-clicking a text element — resets a
  text component from the pasted string, so a pasted `<div>` becomes the *text* `slides`
  rather than a component. Measured in `scratch/s4a/probe-paste.json` and
  `probe-paste-tail.json`.
- The 200 is gone. The same bytes now get `SKW_E_RT_BODY_FORBIDDEN` (`rule: 'no-component'`)
  and zero rows, because a body with content and no registered component is the signature of
  the degradation.

**F2 is therefore a latent path, not a live one** — S4a's "Major, by construction" overstated
it: no reachable affordance feeds GrapesJS a document today. It is one `editable: true` (or
one import button) away from being live, and the three closings below cost little and remove
the class.

### 2.2 (a) The paste gate — before GrapesJS parses

`app/editor/paste.ts` owns the pattern and the reference scanner
(`DATA_GJS_TYPE_PATTERN`, `pastedTypes()`, `assertPasteAllowed()`); the boot script in
`app/admin/editor.ts` receives that pattern verbatim (`JSON.stringify` of the constant, so
quoting cannot drift) and installs a **capture-phase `paste` listener on the canvas document**,
re-attached on `canvas:frame:load`, `canvas:frame:load:body` and `load` because the canvas is
an iframe whose document is replaced.

On paste: read `text/html`, then `text/plain` (GrapesJS's own RTE handler inserts plain text
through `insertHTML`, so plain text *is* markup there); scan every `data-gjs-type`; if any is
not in `boot.types`, `preventDefault()` + `stopImmediatePropagation()` and show
`#skw-notice` (`role="alert"`, `data-code`, `data-type`) naming the type. The **whole** paste
is refused — nothing partial lands. A bare `data-gjs-type` with no value is refused too
(fail-closed); the cost is a refused paste of documentation that quotes the attribute, which
is the safe direction.

The **import chokepoint** is the same scanner: every document that enters the canvas goes
through `applyDocument(html)`, and `applyDocument` is now the only `editor.setComponents` call
in the served script — asserted by `P4`, which counts them:

```js
assert.equal((EDITOR_BOOT_JS.match(/editor\.setComponents\(/g) ?? []).length, 1);
```

Both the load and the picker use it. This is the part that exists today: the picker's answer
is the client's own bytes echoed back, so it is the one reachable import of client-supplied
HTML, and it is now scanned before GrapesJS sees it.

### 2.3 (b) The inventory — belt and braces, and honestly redundant for the paste

`window.skwSave` now also posts `components: [...]`, the `data-gjs-type` values of every
registered component in the canvas model (document order, walked from the wrapper). The route
accepts it as an optional array of strings (`SKW_E_PLT_REQUEST_INVALID` otherwise) and
`savePage()` compares it as a **multiset** against the locks in the bytes it is about to
write:

```
SKW_E_RT_COMPONENT_INVENTORY  422
detail: { page, missing: [...], unexpected: [...], canvas: [...], stored: [...] }
```

**It is redundant with (a) for the paste vector, and the report should say so.** After (a) no
unregistered type can reach the canvas, and — more fundamentally — GrapesJS removes the lock
before the model ever holds that type, so the inventory could not name it either. What (b)
*does* see is the complementary failure: a lock the canvas **did** hold going missing between
the model and the bytes (a stale tab, a second client posting a stripped document, a
serialiser or canon regression). (a) cannot see that by construction, because it inspects the
clipboard and not the document. It is also the only one of the two that a non-browser client
gets.

The code is new (`schema/error-codes.json` + `app/errors.ts`, 422), and the taxonomy's own
count gate moved with it: `test/error-codes.test.ts` 75 → 76.

### 2.4 (c) The three proofs

**1. A paste is refused, in a real browser, and nothing is inserted.**

```
$ scratch/s4a/paste-proof.py            (Chromium 151.0.7922.34, headless, the real app)
2. paste dispatched: {'defaultPrevented': True, 'dispatchReturned': False,
                      'target': 'P', 'clipboardBytes': 49}
   notice: {'hidden': False,
            'text': 'Paste refused (SKW_E_RT_COMPONENT_UNKNOWN): no component is registered for
                     data-gjs-type="carousel". Nothing was inserted.',
            'code': 'SKW_E_RT_COMPONENT_UNKNOWN', 'type': 'carousel'}
   canvas unchanged: True | slides in DOM: False
   save after refused paste: rev=1 unchanged=False
```

- the event was a real `ClipboardEvent` with a real `DataTransfer` carrying the 49 B, dispatched
  on the element GrapesJS's RTE had made contenteditable (`<p data-prop="body">`). A keystroke
  paste could not be delivered: `Meta+V` and CDP `Input.dispatchKeyEvent{commands:['paste']}`
  both inserted nothing in headless Chromium on macOS (measured, `probe-paste-delivery.json`).
  The gate's decision point *is* the event, so the event is what was driven — §4 says so again.
- `dispatchEvent` returned **false**: the listener cancelled it in the capture phase, so
  neither GrapesJS's own paste handler nor the browser's default insertion ran.
- the frame's DOM and the editor's html are unchanged at every point measured before the save
  (`before == after the dispatch == after editing ended`); no `slides` and no `carousel`
  anywhere in the frame.
- the save that follows is a **200 with the unchanged page** — `rev 1` — and the only bytes
  that differ from the pre-paste save are `id="itat"`, which GrapesJS stamps on the text
  element when the RTE opens, plus the re-indentation that attribute causes (96 B → 110 B;
  §4.3). No pasted content is stored. On a body whose only content was the paste the save is
  **422** and writes no row (§2.1) — which is the literal "no 200 on save", and the reason it
  can only be shown on that shape: a page that also holds a real block must stay savable, so
  there the assertion is "the stored bytes gained nothing from the paste", not a status code.

**2. A normal paste still works.**

```
5. benign paste: prevented=False noticeHidden=True storedHasText=True   (rev 2, 134 B)
```

The same dispatch with `text/plain = 'Hello from the clipboard'` and no `data-gjs-type` is
**not** prevented, the notice is cleared, the editing pipeline inserts it, ending the RTE
syncs the model, and the stored bytes contain the text. The gate is not a blanket paste
blocker.

**3. The inventory refusal fires when a lock is removed by another route.**

From the page, with the real CSRF token, posting the canvas's own html with
` data-gjs-type="prose"` removed and the inventory still naming it:

```
6. inventory mismatch: 422 SKW_E_RT_COMPONENT_INVENTORY
   {"page": "/new", "missing": ["prose"], "unexpected": [], "canvas": ["prose"], "stored": []}
```

and over the wire, both directions and the no-inventory case (`test/admin-editor.test.ts` E8):
`missing: ['hero']` when the lock is stripped; `unexpected: ['hero']` when the bytes hold a
component the canvas said it did not have; 200 when the inventory agrees; 200 when none is
sent; only the two agreeing payloads wrote rows.

---

## 3 — What S4b must assume about `body_html`

1. **It is a fragment.** No `<body>`, no `<html>`, no doctype. It starts with the page's first
   component's own tag, in canon's attribute order (`data-gjs-type` first). Any parser that
   treats it as a document is wrong; any renderer that interpolates it into `<main>` is
   right.
2. **Both shapes exist in the table S4b inherits.** Rows written by `436d913` and earlier are
   **wrapped** (11/11 in S4a's browser fixture). The load path still opens them —
   `analyseBody` treats the `<body>` element as a transparent wrapper (S8 asserts the
   component list) — and the **next editor save normalises them**, because `savePage()`
   unwraps every input. An exporter must therefore either normalise with `unwrapBody()` on
   read (`app/editor/canon.ts` — the one implementation, do not write a second) or refuse the
   row with a code. It must not assume the column is uniform until a normalising pass has
   run, and it must not assume the load path refuses a wrapped row: it deliberately does not.
3. **A body with content but no registered component cannot be written any more.**
   `SKW_E_RT_BODY_FORBIDDEN` with `detail.rule = 'no-component'` is that refusal — the exact
   shape of a degraded paste. An **empty** body is still writable (the admin's
   create-then-open flow and the S4a harness both write one), so old empty rows exist and a
   new page can still be created empty; what cannot happen is a body whose content no
   component claims.
4. **`id="i…"` may appear on text elements.** GrapesJS stamps a component id on an element
   when its RTE opens; it is stable across subsequent saves (measured,
   `probe-rte-id.json`: round 1 == round 2), so it does not break the fixpoint, but it is
   canvas noise in content bytes. An exporter must not treat those ids as author anchors and
   must not assume their absence.
5. **The fixpoint is asserted on the bytes the route writes.** `stored(load(stored(load(page))))
   == stored(load(page))` is now measured by posting the canvas's document to
   `/editor/save`, so anything that reads `body_html` reads the same bytes the gate proved
   stable — including the attribute order, the `data-item-position` stamp on list rows, and
   the absence of the canvas's placeholder `src`.
6. **The inventory field is optional on the save API.** An importer or exporter that posts
   documents should send `components` (the `data-gjs-type` multiset it believes it is
   writing) to get the mismatch refusal; omitting it silently skips that check by design.

---

## 4 — What is not covered, and what this run found but did not fix

1. **A keystroke paste.** `Meta+V` and CDP `Input.dispatchKeyEvent{commands:['paste']}` deliver
   nothing in headless Chromium on macOS — the browser process has no pasteboard
   (`probe-paste-delivery.json`: both produced no insertion, even with
   `navigator.clipboard.write` and `clipboard-read`/`clipboard-write` granted). The paste event
   was driven directly instead. A headed run on a machine with a pasteboard is the remaining
   gap, and it is a harness gap, not a product one: the handler is the event's capture phase.
2. **The RTE as a vector.** Pasting markup into the rich-text editor flattens it to text
   (measured: `Write the paragraph here.slides`), so today the RTE cannot create a lockless
   *component*. The gate covers it anyway, because that is a property of the current text
   component, not of the paste path.
3. **F5 (new, minor): the RTE stamps `id` into stored bytes.** Opening a text block's
   rich-text editor adds `id="i…"` to the element, which the save stores (96 B → 110 B on the
   prose page). It is stable afterwards, so the fixpoint holds, but it is canvas noise in
   `body_html` and it makes "the bytes are unchanged by a refused paste" true only modulo
   that attribute. Not fixed: `id` is also a legitimate author anchor on a component, so
   stripping it is a product decision, not a line.
4. **F3 and F4 from S4a are untouched** (the canvas is an iframe; the picker's `previewUrl` is
   discarded by the boot script), as is S4a's §9 list of undriven flows.

---

## 5 — The gate, after the last edit

```
$ make test
# tests 468
# suites 10
# pass 468
# fail 0
# skipped 0
verify-dist: 6/6 passed — the artefact on disk is the one asserted
verify-no-leak: auditing the daemon for skw-* (before: 0 container(s), 0 network(s))
verify-no-leak: clean — 0 skw-* containers, 0 skw-* networks
RC=0
```

458 → 468: `RT-2`, `RT-13`, `E8`, `E9`, `P1`–`P4`, `S8`, `S9`. The taxonomy count moved with
the new code (75 → 76) in the same commit-free change. `SKW_ALLOW_SKIP` was never set.

*Uncommitted by instruction. `scratch/s4a/run/state.json` is tracked and modified: it is the
server address and fixture path the browser evidence came from.*

---

## Appendix A — reproducing

```bash
# the gate, and the red proof
node --test --test-concurrency=1 test/roundtrip.test.ts
TMPDIR=$PWD/scratch/s4a node scratch/s4a/fixture-bytes.mts      # the 9-fixture table
# revert app/editor/save.ts to `analyseBody({ html: input.html })`, re-run the first command

# the browser proofs (reuses the S4a harness)
TMPDIR=$PWD/scratch/s4a node scratch/s4a/browser-server.mts &
/Users/cyberdeth/.hermes/installs/b86edf720dadbbe8/environments/8a335f5c0cb24326a033f193f348175b/venv/bin/python \
  scratch/s4a/paste-proof.py                                   # writes scratch/s4a/paste-evidence.json
```

`scratch/s4a/probe-paste*.py` and `probe-rte-id.py` are the measurements §2 and §4 quote;
their JSON outputs sit beside them. `scratch/s4a/evidence-fix.json` is the §1.5 sweep
(`browser-drive.py` writes `evidence.json`, which is restored to S4a's run so that report's
appendix still matches the file it cites).
