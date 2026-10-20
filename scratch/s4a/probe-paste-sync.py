"""Probe 3: model sync after an editing-pipeline insertion (what a paste's default action does).

A synthetic ClipboardEvent cannot perform the browser's default insertion; this measures the
faithful substitute — Blink's own editing command on the focused RTE element, followed by the
`input` event that a real paste fires — and whether GrapesJS's model picks it up (which is what
`getHtml()` and therefore the save would see).
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
PAYLOAD = '<div data-gjs-type="carousel"><p>slides</p></div>'


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
    raise SystemExit('no canvas frame')


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    page = ctx.new_page()

    page.goto(BASE + '/admin/login')
    page.fill('input[name=email]', STATE['email'])
    page.fill('input[name=password]', STATE['password'])
    page.fill('input[name=totp]', totp(STATE['totpSecret']))
    page.click('button[type=submit]')
    page.wait_for_load_state()

    out = {}
    for label, command, arg in (
        ('html-after-gate-removed', 'insertHTML', PAYLOAD),
        ('text-insert', 'insertText', 'Hello from the clipboard'),
    ):
        page.goto(BASE + '/admin/t/acme/editor')
        ready(page)
        page.click('#skw-blocks button[data-type="prose"]')
        page.wait_for_timeout(500)
        frame = canvas_frame(page)
        frame.dblclick('[data-prop="body"]', timeout=8000)
        page.wait_for_timeout(300)
        before = page.evaluate("() => window.grapesjs.editors[0].getHtml()")
        page.evaluate(
            """({command, arg}) => {
                const ed = window.grapesjs.editors[0];
                const doc = ed.Canvas.getDocument();
                const el = doc.querySelector('[data-prop="body"]');
                // The gate is bypassed for this control: the question is what the editing
                // pipeline does to the payload, not whether the gate stops it.
                doc.__skwPasteGate = false;
                el.focus();
                doc.execCommand(command, false, arg);
                el.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertFromPaste'}));
            }""",
            {'command': command, 'arg': arg},
        )
        page.wait_for_timeout(600)
        out[label] = {
            'command': command,
            'before': before,
            'after': page.evaluate("() => window.grapesjs.editors[0].getHtml()"),
            'bodyText': page.evaluate("() => window.grapesjs.editors[0].Canvas.getDocument().body.innerText"),
            'save': page.evaluate("() => window.skwSave()"),
        }
        print(label, '->', json.dumps(out[label]['after'])[:400])
        print('   save:', json.dumps(out[label]['save'])[:300])

    json.dump(out, open(OUT / 'probe-paste-sync.json', 'w'), indent=2)
    browser.close()
