"""Probe 4: does an RTE insertion reach the model when editing ends (the paste's real tail)?

GrapesJS syncs the rich-text element into the model on `sync:content`, which fires when the
RTE is disabled — clicking out of the block — or when the project is stored. A paste that
inserts markup therefore becomes visible to `getHtml()` only after the operator clicks away.
This measures that sequence for (a) the unregistered payload and (b) plain text.
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


def escape(page):
    """End the RTE: click the settings pane, which is outside the canvas."""
    page.mouse.click(1330, 300)
    page.wait_for_timeout(600)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
    page = ctx.new_page()
    page.goto(BASE + '/admin/login')
    page.fill('input[name=email]', STATE['email'])
    page.fill('input[name=password]', STATE['password'])
    page.fill('input[name=totp]', totp(STATE['totpSecret']))
    page.click('button[type=submit]')
    page.wait_for_load_state()

    out = {}
    for label, command, arg in (
        ('markup', 'insertHTML', PAYLOAD),
        ('text', 'insertText', 'Hello from the clipboard'),
    ):
        page.goto(BASE + '/admin/t/acme/editor')
        ready(page)
        page.click('#skw-blocks button[data-type="prose"]')
        page.wait_for_timeout(400)
        # A path per run: the editor was opened blank, so a save is a create.
        page.evaluate(
            """() => { window.grapesjs.editors[0].getModel().get('Pages'); }"""
        )
        frame = canvas_frame(page)
        frame.dblclick('[data-prop="body"]', timeout=8000)
        page.wait_for_timeout(300)
        page.evaluate(
            """({command, arg}) => {
                const ed = window.grapesjs.editors[0];
                const doc = ed.Canvas.getDocument();
                const el = doc.querySelector('[data-prop="body"]');
                doc.__skwPasteGate = false;   // control: the gate is not the subject here
                el.focus();
                doc.execCommand(command, false, arg);
            }""",
            {'command': command, 'arg': arg},
        )
        in_rte = page.evaluate("() => window.grapesjs.editors[0].getHtml()")
        escape(page)
        after_escape = page.evaluate("() => window.grapesjs.editors[0].getHtml()")
        out[label] = {
            'inRte': in_rte,
            'afterEditingEnded': after_escape,
            'changedByInsertion': in_rte != after_escape,
            'bodyText': page.evaluate("() => window.grapesjs.editors[0].Canvas.getDocument().body.innerText"),
        }
        print(label, 'inRte:', json.dumps(in_rte)[:200])
        print(label, 'after:', json.dumps(after_escape)[:400])
        print(label, 'text :', json.dumps(out[label]['bodyText'])[:200])

    json.dump(out, open(OUT / 'probe-paste-tail.json', 'w'), indent=2)
    browser.close()
