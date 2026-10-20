"""S4a F2 — the paste gate, driven in a real browser. Evidence for docs/build/S4a-fix-report.md.

What is driven, and what could not be:

  * A **paste** is a `ClipboardEvent` with a real `DataTransfer` carrying 49 B, dispatched on
    the focused element of GrapesJS's rich-text editor — the only editable surface the canvas
    has. A keystroke paste (Cmd+V, and CDP `Input.dispatchKeyEvent` with `commands:['paste']`)
    could not be delivered in headless Chromium on macOS: the browser process has no
    pasteboard (measured in scratch/s4a/probe-paste-delivery.json — both delivered nothing).
    The gate's decision point *is* the event, so the event is driven directly.
  * The **import** path is measured where it exists: `editor.setComponents()` is the call
    that parses a document, and the boot script now routes every document through
    `applyDocument()` before it. The raw call is driven here to show the damage the
    chokepoint prevents (49 B -> the lock is gone).
  * The **inventory** refusal is driven from the page, with the real CSRF token, exactly as
    the boot script would post it, with one lock removed from the html.

Writes scratch/s4a/paste-evidence.json and prints every measurement.
"""
import base64
import hashlib
import hmac
import json
import sqlite3
import struct
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path('/Volumes/Backup/Development/skunkworks')
OUT = ROOT / 'scratch' / 's4a'
STATE = json.load(open(OUT / 'run' / 'state.json'))
BASE = STATE['base']
SITE_DB = STATE['siteDb']
PAYLOAD = '<div data-gjs-type="carousel"><p>slides</p></div>'
BENIGN = 'Hello from the clipboard'


def totp(secret_b32, t=None):
    key = base64.b32decode(secret_b32)
    counter = int((t or time.time()) // 30)
    mac = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    return f"{(struct.unpack('>I', mac[off:off + 4])[0] & 0x7FFFFFFF) % 1000000:06d}"


def ready(page):
    page.wait_for_function(
        "() => typeof window.skwSave === 'function' && window.grapesjs && "
        "window.grapesjs.editors && window.grapesjs.editors.length > 0",
        timeout=15000,
    )


def canvas_frame(page):
    for f in page.frames:
        if f == page.main_frame:
            continue
        try:
            if f.evaluate("() => !!document.querySelector('[data-prop=\"body\"]')"):
                return f
        except Exception:
            continue
    raise RuntimeError('no canvas frame with a prose paragraph')


def stored(path):
    con = sqlite3.connect(f'file:{SITE_DB}?mode=ro', uri=True)
    try:
        return con.execute('SELECT id, rev, body_html FROM cms_page WHERE path = ?', (path,)).fetchone()
    finally:
        con.close()


def dispatch_paste(page, html, plain=None):
    """A real ClipboardEvent, real DataTransfer, on the element the RTE made editable."""
    return page.evaluate(
        """({html, plain}) => {
            const ed = window.grapesjs.editors[0];
            const doc = ed.Canvas.getDocument();
            const target = doc.activeElement && doc.activeElement.isContentEditable
                ? doc.activeElement
                : doc.querySelector('[data-prop="body"]');
            const dt = new DataTransfer();
            dt.setData('text/html', html);
            dt.setData('text/plain', plain === null ? html : plain);
            const ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true});
            const returned = target.dispatchEvent(ev);
            return {
                defaultPrevented: ev.defaultPrevented,
                dispatchReturned: returned,
                target: target.tagName,
                clipboardBytes: dt.getData('text/html').length,
            };
        }""",
        {'html': html, 'plain': plain},
    )


def notice(page):
    return page.evaluate(
        """() => {
            const n = document.getElementById('skw-notice');
            return {hidden: n.hidden, text: n.textContent,
                    code: n.getAttribute('data-code'), type: n.getAttribute('data-type')};
        }"""
    )


def state(page):
    return page.evaluate(
        """() => {
            const ed = window.grapesjs.editors[0];
            const doc = ed.Canvas.getDocument();
            const types = [];
            const walk = (c) => { types.push(c.get('type')); c.components().forEach(walk); };
            ed.getWrapper().components().forEach(walk);
            return {
                html: ed.getHtml(),
                types: types,
                bodyText: doc.body.innerText,
                canvasHasSlides: doc.body.innerHTML.indexOf('slides') !== -1,
                canvasHasCarousel: doc.body.innerHTML.indexOf('carousel') !== -1,
            };
        }"""
    )


def end_editing(page):
    """Click the settings pane: the RTE disables and GrapesJS syncs the DOM into the model."""
    page.mouse.click(1330, 300)
    page.wait_for_timeout(600)


evidence = {'payload': PAYLOAD, 'payloadBytes': len(PAYLOAD)}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
    page = ctx.new_page()
    console = []
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))
    responses = []
    page.on('response', lambda r: responses.append((r.url.split('/admin/t/acme')[-1], r.status))
            if '/editor/' in r.url else None)

    page.goto(BASE + '/admin/login')
    page.fill('input[name=email]', STATE['email'])
    page.fill('input[name=password]', STATE['password'])
    page.fill('input[name=totp]', totp(STATE['totpSecret']))
    page.click('button[type=submit]')
    page.wait_for_load_state()
    evidence['engine'] = f'{browser.browser_type.name} {browser.version}'

    # ---- 1. a page with one block, saved through the product --------------------------
    page.goto(BASE + '/admin/t/acme/editor')
    ready(page)
    page.click('#skw-blocks button[data-type="prose"]')
    page.wait_for_timeout(500)
    first = page.evaluate("() => window.skwSave()")
    page_id = first['id']
    row = stored('/new')
    evidence['saveBefore'] = {
        'status': 200 if 'bodyHtml' in first else first,
        'id': page_id,
        'storedBytes': len(row[2]),
        'startsWithBody': row[2].lstrip().lower().startswith('<body'),
        'startsWithComponent': row[2].startswith('<div data-gjs-type="prose"'),
        'bodyHtml': row[2],
    }
    print('1. save #1:', json.dumps(evidence['saveBefore'], indent=1)[:800])

    # ---- 2. the paste, on the page just saved ------------------------------------------
    page.goto(f'{BASE}/admin/t/acme/editor?page={page_id}')
    ready(page)
    frame = canvas_frame(page)
    frame.dblclick('[data-prop="body"]', timeout=8000)
    page.wait_for_timeout(300)
    before = state(page)
    disp = dispatch_paste(page, PAYLOAD)
    page.wait_for_timeout(400)
    after = state(page)
    note = notice(page)
    print('2. paste dispatched:', disp)
    print('   notice:', note)
    print('   canvas unchanged:', before['html'] == after['html'], '| slides in DOM:', after['canvasHasSlides'])

    end_editing(page)
    synced = state(page)
    saved_after = page.evaluate("() => window.skwSave()")
    row_after = stored('/new')
    evidence['pasteRefused'] = {
        'dispatch': disp,
        'notice': note,
        'canvasBefore': before['html'],
        'canvasAfterDispatch': after['html'],
        'canvasAfterEditingEnded': synced['html'],
        'unchanged': before['html'] == after['html'] == synced['html'],
        'slidesInCanvas': after['canvasHasSlides'],
        'saveAfter': {'status': 200 if 'bodyHtml' in saved_after else saved_after,
                      'bodyHtml': saved_after.get('bodyHtml'), 'rev': saved_after.get('rev')},
        'storedAfter': row_after[2],
        'storedUnchanged': row_after[2] == row[2],
        'rowsForPath': stored('/new') is not None,
    }
    print('   save after refused paste: rev=%s unchanged=%s'
          % (saved_after.get('rev'), row_after[2] == row[2]))

    # ---- 3. the save of the degraded document: what S4a measured as a 200 -------------
    degraded = '<div><p>slides</p></div>'
    post_degraded = page.evaluate(
        """async (html) => {
            const boot = JSON.parse(document.getElementById('skw-editor-boot').textContent);
            const r = await fetch('/admin/t/acme/editor/save', {
                method: 'POST', credentials: 'same-origin',
                headers: {'content-type': 'application/json', 'x-csrf-token': boot.csrf},
                body: JSON.stringify({path: '/degraded-from-canvas', title: 'D', template: 'page', html}),
            });
            return {status: r.status, body: await r.json()};
        }""",
        degraded,
    )
    con = sqlite3.connect(f'file:{SITE_DB}?mode=ro', uri=True)
    rows = con.execute("SELECT count(*) FROM cms_page WHERE path = '/degraded-from-canvas'").fetchone()[0]
    con.close()
    evidence['degradedSave'] = {'submitted': degraded, 'status': post_degraded['status'],
                                'code': post_degraded['body'].get('error', {}).get('code'),
                                'detail': post_degraded['body'].get('error', {}).get('detail'),
                                'rowsWritten': rows}
    print('3. degraded save:', post_degraded['status'], post_degraded['body'].get('error', {}).get('code'),
          'rows=%s' % rows)

    # ---- 4. the import path the chokepoint guards: setComponents with the same 49 B ----
    page.goto(f'{BASE}/admin/t/acme/editor?page={page_id}')
    ready(page)
    raw = page.evaluate(
        """(html) => {
            const ed = window.grapesjs.editors[0];
            ed.setComponents(html);
            return {html: ed.getHtml(), bytes: ed.getHtml().length};
        }""",
        PAYLOAD,
    )
    evidence['importDamaged'] = {'inBytes': len(PAYLOAD), 'outBytes': len(raw['html']), 'out': raw['html']}
    print('4. raw import:', len(PAYLOAD), 'B ->', len(raw['html']), 'B, lock kept:',
          'data-gjs-type="carousel"' in raw['html'])

    # ---- 5. a normal paste still works: no lock in the payload, gate does not fire ------
    page.goto(f'{BASE}/admin/t/acme/editor?page={page_id}')
    ready(page)
    frame = canvas_frame(page)
    frame.dblclick('[data-prop="body"]', timeout=8000)
    page.wait_for_timeout(300)
    benign_dispatch = dispatch_paste(page, BENIGN, plain=BENIGN)
    page.wait_for_timeout(200)
    benign_notice = notice(page)
    # The browser's default insertion is what a real paste does next; drive the same editing
    # command, then end editing so the model syncs it.
    page.evaluate(
        """(text) => {
            const doc = window.grapesjs.editors[0].Canvas.getDocument();
            const el = doc.activeElement && doc.activeElement.isContentEditable
                ? doc.activeElement : doc.querySelector('[data-prop="body"]');
            el.focus();
            doc.execCommand('insertText', false, text);
        }""",
        BENIGN,
    )
    end_editing(page)
    benign_saved = page.evaluate("() => window.skwSave()")
    benign_row = stored('/new')
    evidence['benignPaste'] = {
        'dispatch': benign_dispatch,
        'notice': benign_notice,
        'stored': benign_row[2],
        'storedHasText': BENIGN in (benign_row[2] or ''),
        'rev': benign_saved.get('rev'),
    }
    print('5. benign paste: prevented=%s noticeHidden=%s storedHasText=%s'
          % (benign_dispatch['defaultPrevented'], benign_notice['hidden'],
             BENIGN in (benign_row[2] or '')))

    # ---- 6. the inventory refusal, from the page, with a lock removed -----------------
    canvas = page.evaluate("() => window.grapesjs.editors[0].getHtml()")
    stripped = canvas.replace(' data-gjs-type="prose"', '')
    inv = page.evaluate(
        """async ({stripped, inventory}) => {
            const boot = JSON.parse(document.getElementById('skw-editor-boot').textContent);
            const r = await fetch('/admin/t/acme/editor/save', {
                method: 'POST', credentials: 'same-origin',
                headers: {'content-type': 'application/json', 'x-csrf-token': boot.csrf},
                body: JSON.stringify({id: %d, path: '/new', title: 'New page', template: 'page',
                                      html: stripped, components: inventory}),
            });
            return {status: r.status, body: await r.json()};
        }""" % page_id,
        {'stripped': stripped, 'inventory': ['prose']},
    )
    evidence['inventory'] = {
        'canvasHtml': canvas,
        'submittedHtml': stripped,
        'inventory': ['prose'],
        'status': inv['status'],
        'code': inv['body'].get('error', {}).get('code'),
        'detail': inv['body'].get('error', {}).get('detail'),
    }
    print('6. inventory mismatch:', inv['status'], inv['body'].get('error', {}).get('code'),
          json.dumps(inv['body'].get('error', {}).get('detail')))

    evidence['console'] = console[-10:]
    evidence['responses'] = responses
    json.dump(evidence, open(OUT / 'paste-evidence.json', 'w'), indent=2)
    print('\nengine:', evidence['engine'])
    print('console:', console[-5:])
    browser.close()
