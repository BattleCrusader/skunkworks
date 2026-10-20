"""Probe: is the canvas a live paste target, and does a real paste strip the lock?

Not evidence — a measurement to decide where the paste gate has to live. It prints, into
scratch/s4a/probe-paste.json: each frame's class/size, the canvas body's contenteditable
state, whether a double-click opens GrapesJS's rich-text editor on a prose paragraph, what
a real clipboard paste (Cmd+V) does to the model, and what a synthetic paste event does.
"""
import base64
import hashlib
import hmac
import json
import struct
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path('/Volumes/Backup/Development/skunkworks')
OUT = ROOT / 'scratch' / 's4a'
STATE = json.load(open(OUT / 'run' / 'state.json'))
BASE = STATE['base']


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


def frames_of(page):
    out = []
    for f in page.frames:
        if f == page.main_frame:
            continue
        try:
            info = f.evaluate(
                """() => {
                    const f = window.frameElement;
                    return {
                      cls: f ? f.className : null,
                      w: f ? f.getBoundingClientRect().width : null,
                      h: f ? f.getBoundingClientRect().height : null,
                      bodyEditable: document.body ? document.body.isContentEditable : null,
                      bodyAttr: document.body ? document.body.getAttribute('contenteditable') : null,
                      hasProse: !!document.querySelector('[data-prop="body"]'),
                    };
                }"""
            )
        except Exception as exc:  # a cross-origin or detached frame
            info = {'error': str(exc)[:100]}
        out.append({'url': f.url[:60], **info})
    return out


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    page = ctx.new_page()
    console = []
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: console.append(f'pageerror: {e}'))

    page.goto(BASE + '/admin/login')
    page.fill('input[name=email]', STATE['email'])
    page.fill('input[name=password]', STATE['password'])
    page.fill('input[name=totp]', totp(STATE['totpSecret']))
    page.click('button[type=submit]')
    page.wait_for_load_state()

    page.goto(BASE + '/admin/t/acme/editor')
    ready(page)
    page.click('#skw-blocks button[data-type="prose"]')
    page.wait_for_timeout(800)

    before = page.evaluate(
        """() => {
            const ed = window.grapesjs.editors[0];
            const body = ed.Canvas.getBody();
            return {
              bodyEditable: body.isContentEditable,
              bodyAttr: body.getAttribute('contenteditable'),
              html: ed.getHtml(),
              frames: document.querySelectorAll('#gjs iframe').length,
            };
        }"""
    )
    frame_list = frames_of(page)

    # Double-click the paragraph inside the canvas: GrapesJS opens its rich-text editor on an
    # editable element, which is the moment the canvas becomes a paste target.
    target = None
    for f in page.frames:
        if f == page.main_frame:
            continue
        try:
            if f.evaluate("() => !!document.querySelector('[data-prop=\"body\"]')"):
                target = f
                break
        except Exception:
            continue

    rte_before = page.evaluate("() => ({editing: !!window.grapesjs.editors[0].getEditing()})")
    if target is not None:
        try:
            target.dblclick('[data-prop="body"]', timeout=8000)
        except Exception as exc:
            console.append(f'dblclick failed: {exc}'[:200])
    page.wait_for_timeout(600)
    rte_after = page.evaluate(
        """() => {
            const ed = window.grapesjs.editors[0];
            const doc = ed.Canvas.getDocument();
            const el = doc.querySelector('[data-prop="body"]');
            return {
              editing: !!ed.getEditing(),
              activeTag: el ? el.tagName : null,
              contentEditable: el ? el.isContentEditable : null,
              docActive: doc.activeElement ? doc.activeElement.tagName : null,
            };
        }"""
    )

    html = '<div data-gjs-type="carousel"><p>slides</p></div>'
    wrote = page.evaluate(
        """async (html) => {
            const item = new ClipboardItem({
                'text/html': new Blob([html], {type: 'text/html'}),
                'text/plain': new Blob([html], {type: 'text/plain'}),
            });
            await navigator.clipboard.write([item]);
            return (await navigator.clipboard.readText()).slice(0, 60);
        }""",
        html,
    )

    page.keyboard.press('Meta+V')
    page.wait_for_timeout(900)
    after_key = page.evaluate(
        """() => {
            const ed = window.grapesjs.editors[0];
            const types = [];
            const walk = (c) => { types.push(c.get('type')); c.components().forEach(walk); };
            ed.getWrapper().components().forEach(walk);
            const doc = ed.Canvas.getDocument();
            return {html: ed.getHtml(), types, bodyText: doc.body.innerText.slice(0, 200)};
        }"""
    )

    synthetic = page.evaluate(
        """(html) => {
            const ed = window.grapesjs.editors[0];
            const doc = ed.Canvas.getDocument();
            const dt = new DataTransfer();
            dt.setData('text/html', html);
            dt.setData('text/plain', html);
            const ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true});
            const returned = doc.body.dispatchEvent(ev);
            return {defaultPrevented: ev.defaultPrevented, dispatchReturned: returned,
                    clipboardBytes: (ev.clipboardData && ev.clipboardData.getData('text/html')).length};
        }""",
        html,
    )
    page.wait_for_timeout(400)
    after_synth = page.evaluate("() => window.grapesjs.editors[0].getHtml()")

    out = {
        'before': before,
        'frames': frame_list,
        'rteBefore': rte_before,
        'rteAfterDoubleClick': rte_after,
        'clipboardReadBack': wrote,
        'afterKeystroke': after_key,
        'syntheticPaste': synthetic,
        'afterSynthetic': after_synth,
        'console': console[-20:],
    }
    json.dump(out, open(OUT / 'probe-paste.json', 'w'), indent=2)
    print(json.dumps({k: v for k, v in out.items() if k != 'console'}, indent=2)[:5000])
    print('console:', console[-6:])
    browser.close()
