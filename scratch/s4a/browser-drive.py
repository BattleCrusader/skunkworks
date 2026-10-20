"""S4a ITEM 1 and 2 — the editor driven in a real browser.

A real Chrome (Playwright's chromium build, headless) drives the real admin surface over a
real socket: the login form, the palette, the canvas, `window.skwSave`, the media picker, and
the page reload. Every document that is compared is read back from `cms_page.body_html` in
SQLite — the stored bytes, not the editor's opinion of them.

Per registry component: insert from the palette -> save (B1) -> reload the page into the
editor -> save (B2). `survived` means B1 == B2 *and* the registry's lock (`data-gjs-type`),
its `data-prop` fields and its `data-asset-key` survive. Anything else is reported as it is.

Also: an unregistered `data-gjs-type` at load and at save, and the picker's key-not-URL.
"""
import base64
import hashlib
import hmac
import json
import re
import sqlite3
import struct
import sys
import time
from html.parser import HTMLParser
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path('/Volumes/Backup/Development/skunkworks')
OUT = ROOT / 'scratch' / 's4a'
STATE = json.load(open(OUT / 'run' / 'state.json'))
BASE = STATE['base']
SITE_DB = STATE['siteDb']
SHOTS = OUT / 'shots'
SHOTS.mkdir(parents=True, exist_ok=True)

REGISTRY = json.load(open(ROOT / 'schema' / 'component-registry.json'))
ENTRIES = {c['name']: c for c in REGISTRY['components'] if c['kind'] != 'shell'}

PALETTE_ORDER = [item['type'] for item in STATE['palette']]


# ---------------------------------------------------------------- helpers

def totp(secret_b32, t=None):
    key = base64.b32decode(secret_b32)
    counter = int((t or time.time()) // 30)
    mac = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    return f"{(struct.unpack('>I', mac[off:off + 4])[0] & 0x7FFFFFFF) % 1000000:06d}"


def stored_body(path):
    con = sqlite3.connect(f'file:{SITE_DB}?mode=ro', uri=True)
    try:
        row = con.execute('SELECT id, rev, body_html FROM cms_page WHERE path = ?', (path,)).fetchone()
        return row
    finally:
        con.close()


class Shape(HTMLParser):
    """Every element's tag + attributes, in document order — what actually survived."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.els = []

    def handle_starttag(self, tag, attrs):
        self.els.append((tag, dict(attrs)))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)


def shape(html):
    p = Shape()
    p.feed(html)
    return p.els


def locks(html):
    els = shape(html)
    return {
        'type': [a.get('data-gjs-type') for _, a in els if 'data-gjs-type' in a],
        'props': [a.get('data-prop') for _, a in els if 'data-prop' in a],
        'keys': [a.get('data-asset-key') for _, a in els if 'data-asset-key' in a],
        'tags': [t for t, _ in els],
    }


def expected_locks(name):
    entry = ENTRIES[name]
    s = locks(entry['html'])
    return {
        'type': [entry['type']],
        'props': [f['prop'] for f in entry.get('editable', [])],
        'keys': sorted(set(s['keys'])),
        'tags': s['tags'],
    }


def editor_ready(page):
    page.wait_for_function(
        "() => typeof window.skwSave === 'function' && window.grapesjs && "
        "window.grapesjs.editors && window.grapesjs.editors.length > 0",
        timeout=15000,
    )


CANVAS_EXPR = """() => {
  const f = document.querySelector('#gjs iframe');
  const d = f && f.contentDocument;
  return d ? d.body.innerHTML : null;
}"""


def canvas_html(page):
    return page.evaluate(CANVAS_EXPR)


def canvas_frame(page, selector):
    """The frame that actually holds `selector` — GrapesJS leaves two iframes in #gjs."""
    for frame in page.frames:
        if frame == page.main_frame:
            continue
        try:
            if frame.evaluate('(sel) => !!document.querySelector(sel)', selector):
                return frame
        except Exception:
            continue
    return None


def editor_html(page):
    return page.evaluate("() => window.grapesjs.editors[0].getHtml()")


def seed_page(page, path, title, html=''):
    """Create the row the product flow will open: the same route the boot script posts to."""
    return page.evaluate(
        """async ({path, title, html}) => {
            const boot = JSON.parse(document.getElementById('skw-editor-boot').textContent);
            const r = await fetch('/admin/t/acme/editor/save', {
                method: 'POST', credentials: 'same-origin',
                headers: {'content-type': 'application/json', 'x-csrf-token': boot.csrf},
                body: JSON.stringify({path, title, template: 'page', html}),
            });
            return {status: r.status, body: await r.json()};
        }""",
        {'path': path, 'title': title, 'html': html},
    )


def save(page):
    return page.evaluate("() => window.skwSave()")


def insert(page, type_):
    page.click(f'#skw-blocks button[data-type="{type_}"]')
    page.wait_for_function(
        """(t) => {
            const f = document.querySelector('#gjs iframe');
            const d = f && f.contentDocument;
            return !!(d && d.querySelector('[data-gjs-type="' + t + '"]'));
        }""",
        arg=type_,
        timeout=10000,
    )


def report(rows):
    print('\n| component | palette click | canvas lock | B1 == B2 | verdict |')
    print('|---|---|---|---|---|')


# ---------------------------------------------------------------- the run

evidence = {'components': [], 'unregistered': {}, 'picker': {}, 'palette': PALETTE_ORDER}
failures = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
    page = ctx.new_page()
    console = []
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))
    responses = []

    def on_response(r):
        if '/editor/save' in r.url or '/editor/pick' in r.url:
            responses.append((r.url.split('/admin/t/acme')[-1], r.status))

    page.on('response', on_response)

    # -- login through the real form -------------------------------------
    page.goto(BASE + '/admin/login')
    page.fill('input[name=email]', STATE['email'])
    page.fill('input[name=password]', STATE['password'])
    page.fill('input[name=totp]', totp(STATE['totpSecret']))
    page.click('button[type=submit]')
    page.wait_for_load_state()
    cookies = [c['name'] for c in ctx.cookies()]
    if '__Host-sk-sess' not in cookies:
        sys.exit(f'login did not set the session cookie: {cookies}')
    print(f'login: 200, cookie __Host-sk-sess present, secure={[c["secure"] for c in ctx.cookies()]}')
    print(f'chrome: {browser.browser_type.name} {browser.version}')

    # -- ITEM 1: one component at a time --------------------------------
    for name in PALETTE_ORDER:
        entry = ENTRIES[name]
        path = f'/c/{name}'
        page.goto(BASE + '/admin/t/acme/editor')
        editor_ready(page)
        seeded = seed_page(page, path, entry['label'])
        if seeded['status'] != 200:
            failures.append(f'{name}: seed {seeded["status"]} {seeded["body"]}')
            continue
        page_id = seeded['body']['bodyHtml'] is not None and seeded['body']['id']

        page.goto(f'{BASE}/admin/t/acme/editor?page={page_id}')
        editor_ready(page)
        insert(page, entry['type'])
        canvas = canvas_html(page)
        held = editor_html(page)          # what GrapesJS would submit
        first = save(page)
        if 'bodyHtml' not in first:
            failures.append(f'{name}: save refused {json.dumps(first)[:300]}')
            evidence['components'].append({'name': name, 'error': first})
            continue
        row1 = stored_body(path)
        b1 = row1[2]

        page.screenshot(path=str(SHOTS / f'{name}.png'))
        page.goto(f'{BASE}/admin/t/acme/editor?page={page_id}')
        editor_ready(page)
        held2 = editor_html(page)
        second = save(page)
        row2 = stored_body(path)
        b2 = row2[2]

        exp = expected_locks(name)
        got = locks(b1)
        type_ok = got['type'] == [entry['type']]
        props_ok = all(pr in got['props'] for pr in exp['props'])
        keys_ok = all(k in got['keys'] for k in exp['keys'])
        fixpoint = b1 == b2
        if fixpoint and type_ok and props_ok and keys_ok:
            verdict = 'survived'
        elif not type_ok:
            verdict = 'destroyed'
        else:
            verdict = 'mutated'

        evidence['components'].append({
            'name': name,
            'bodyWrapper': b1.lstrip().startswith('<body'),
            'type': entry['type'],
            'kind': entry['kind'],
            'path': path,
            'pageId': page_id,
            'registryHtml': entry['html'],
            'canvasHtml': canvas,
            'grapesHtmlBeforeSave': held,
            'b1': b1,
            'b2': b2,
            'b1Sha': hashlib.sha256(b1.encode()).hexdigest(),
            'b2Sha': hashlib.sha256(b2.encode()).hexdigest(),
            'grapesHtmlOnReload': held2,
            'locksB1': got,
            'locksExpected': exp,
            'typeOk': type_ok,
            'propsOk': props_ok,
            'keysOk': keys_ok,
            'fixpoint': fixpoint,
            'verdict': verdict,
            'save1Status': first,
            'save2Status': second,
        })
        print()
        print('=== %s (%s) verdict=%s b1==b2=%s type=%s props=%s'
              % (name, entry['kind'], verdict, fixpoint, got['type'], got['props']))
        print('  registry :', entry['html'][:220])
        print('  canvas   :', (canvas or '')[:220])
        print('  B1       :', b1[:400])
        print('  B2       :', b2[:400])

    # -- ITEM 2a-1: an unregistered type in a stored body, at load -----
    con = sqlite3.connect(f'file:{SITE_DB}?mode=ro', uri=True)
    legacy_id = con.execute("SELECT id FROM cms_page WHERE path = '/legacy'").fetchone()[0]
    con.close()
    resp = page.goto(f'{BASE}/admin/t/acme/editor?page={legacy_id}')
    status = resp.status
    payload = json.loads(page.evaluate('() => document.body.innerText'))
    no_canvas = page.evaluate("() => ({gjs: !!document.querySelector('#gjs'), grapes: typeof window.grapesjs})")
    evidence['unregistered']['load'] = {
        'url': f'/admin/t/acme/editor?page={legacy_id}',
        'httpStatus': status,
        'body': payload,
        'canvas': no_canvas,
    }
    print(f'\n=== unregistered at LOAD: {status} {payload["error"]["code"]} '
          f'type={payload["error"].get("detail", {}).get("type")} canvas={no_canvas}')

    # -- ITEM 2a-2: an unregistered type in the bytes the client sends --
    page.goto(BASE + '/admin/t/acme/editor')
    editor_ready(page)
    pasted = '<div data-gjs-type="carousel"><p>slides</p></div>'
    sub = page.evaluate(
        """async (html) => {
            const boot = JSON.parse(document.getElementById('skw-editor-boot').textContent);
            const r = await fetch('/admin/t/acme/editor/save', {
                method: 'POST', credentials: 'same-origin',
                headers: {'content-type': 'application/json', 'x-csrf-token': boot.csrf},
                body: JSON.stringify({path: '/c/unregistered', title: 'U', template: 'page', html}),
            });
            return {status: r.status, body: await r.json()};
        }""",
        pasted,
    )
    con = sqlite3.connect(f'file:{SITE_DB}?mode=ro', uri=True)
    left_behind = con.execute("SELECT count(*) FROM cms_page WHERE path = '/c/unregistered'").fetchone()[0]
    con.close()
    evidence['unregistered']['save'] = {'submitted': pasted, 'status': sub['status'],
                                        'body': sub['body'], 'rowsWritten': left_behind}
    print(f'=== unregistered at SAVE: {sub["status"]} {sub["body"]["error"]["code"]} '
          f'type={sub["body"]["error"].get("detail", {}).get("type")} rows={left_behind}')

    # -- ITEM 2a-3: what GrapesJS does with it when it *does* parse it --
    in_canvas = page.evaluate(
        """(html) => {
            const e = window.grapesjs.editors[0];
            const before = html;
            e.setComponents(html);
            const after = e.getHtml();
            return {before, after, bytesBefore: before.length, bytesAfter: after.length};
        }""",
        pasted,
    )
    canvas_after = canvas_html(page)
    saved_anyway = save(page)
    evidence['unregistered']['inCanvas'] = {**in_canvas, 'canvasHtml': canvas_after,
                                            'save': saved_anyway}
    print(f'=== unregistered in CANVAS: {in_canvas["bytesBefore"]} B -> '
          f'{in_canvas["bytesAfter"]} B: {in_canvas["after"]!r}; save -> '
          f'{saved_anyway.get("bodyHtml")!r}')

    # -- ITEM 2b: the picker writes a key, never a URL -------------------
    page.goto(BASE + '/admin/t/acme/editor')
    editor_ready(page)
    seeded = seed_page(page, '/c/picker', 'Picker')
    pid = seeded['body']['id']
    page.goto(f'{BASE}/admin/t/acme/editor?page={pid}')
    editor_ready(page)
    insert(page, 'figure')
    # Select the component the way an operator does: click it in the canvas.
    page.evaluate("() => { window.prompt = () => %s; }" % json.dumps('gallery/one'))
    frame = canvas_frame(page, '[data-gjs-type="figure"]')
    if frame is None:
        sys.exit('picker: no frame holds the figure component')
    frame.locator('[data-gjs-type="figure"]').click()
    page.wait_for_function(
        "() => !!document.querySelector('#skw-settings button')",
        timeout=10000,
    )
    settings_before = page.evaluate("() => document.getElementById('skw-settings').innerText")
    with page.expect_response(lambda r: '/editor/pick' in r.url) as picked:
        page.click('#skw-settings button')
    pick_json = picked.value.json()
    page.wait_for_timeout(300)
    canvas_after_pick = canvas_html(page)
    after = save(page)
    row = stored_body('/c/picker')
    evidence['picker'] = {
        'settingsPanel': settings_before,
        'pickStatus': picked.value.status,
        'pickResponse': pick_json,
        'canvasAfterPick': canvas_after_pick,
        'saveResponseStatus': after,
        'stored': row[2],
        'storedHasKey': 'data-asset-key="gallery/one"' in row[2],
        'storedHasMediaUrl': bool(re.search(r'/media/', row[2])),
        'previewUrlWasUrl': bool(re.search(r'/media/', pick_json.get('previewUrl', ''))),
    }
    print(f'\n=== picker: {picked.value.status} key={pick_json.get("key")} '
          f'previewUrl={pick_json.get("previewUrl")}')
    print('  stored:', row[2])
    print(f'  storedHasKey={evidence["picker"]["storedHasKey"]} '
          f'storedHasMediaUrl={evidence["picker"]["storedHasMediaUrl"]}')

    print('\nresponses seen:', responses)
    print('console:', console[-8:])
    evidence['console'] = console
    evidence['browser'] = f'{browser.browser_type.name} {browser.version}'
    browser.close()

json.dump(evidence, open(OUT / 'evidence.json', 'w'), indent=2)

print('\n--- summary ---')
for c in evidence['components']:
    if 'error' in c:
        print(f'{c["name"]:<16} ERROR {c["error"]}')
    else:
        print(f'{c["name"]:<16} {c["verdict"]:<10} fixpoint={c["fixpoint"]} '
              f'type={c["locksB1"]["type"]} props={c["locksB1"]["props"]}')
print('failures:', failures)
