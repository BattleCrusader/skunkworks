"""Probe 2: can a real clipboard paste be delivered to the RTE in headless Chromium?

Tries three deliveries of the same clipboard payload and prints which one produced an
actual insertion. The answer decides how the F2 browser proof is driven (and the report
says which one it was).
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
    return None


def body_text(page):
    return page.evaluate(
        """() => {
            const ed = window.grapesjs.editors[0];
            return ed.Canvas.getDocument().body.innerText;
        }"""
    )


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    page = ctx.new_page()
    console = []
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}'))

    page.goto(BASE + '/admin/login')
    page.fill('input[name=email]', STATE['email'])
    page.fill('input[name=password]', STATE['password'])
    page.fill('input[name=totp]', totp(STATE['totpSecret']))
    page.click('button[type=submit]')
    page.wait_for_load_state()

    results = {}
    session = ctx.new_cdp_session(page)

    for label in ('keyboard', 'cdp-commands', 'execCommand-insertHTML'):
        page.goto(BASE + '/admin/t/acme/editor')
        ready(page)
        page.click('#skw-blocks button[data-type="prose"]')
        page.wait_for_timeout(500)
        frame = canvas_frame(page)
        frame.dblclick('[data-prop="body"]', timeout=8000)
        page.wait_for_timeout(300)
        page.evaluate(
            """async (html) => {
                const item = new ClipboardItem({
                    'text/html': new Blob([html], {type: 'text/html'}),
                    'text/plain': new Blob([html], {type: 'text/plain'}),
                });
                await navigator.clipboard.write([item]);
            }""",
            PAYLOAD,
        )
        before = body_text(page)
        if label == 'keyboard':
            page.keyboard.press('Meta+V')
        elif label == 'cdp-commands':
            session.send('Input.dispatchKeyEvent', {
                'type': 'keyDown', 'modifiers': 4, 'key': 'v', 'code': 'KeyV',
                'windowsVirtualKeyCode': 86, 'nativeVirtualKeyCode': 9, 'commands': ['paste'],
            })
            session.send('Input.dispatchKeyEvent', {
                'type': 'keyUp', 'modifiers': 4, 'key': 'v', 'code': 'KeyV',
                'windowsVirtualKeyCode': 86, 'nativeVirtualKeyCode': 9,
            })
        else:
            page.evaluate(
                """(html) => {
                    const doc = window.grapesjs.editors[0].Canvas.getDocument();
                    const el = doc.querySelector('[data-prop="body"]');
                    el.focus();
                    doc.execCommand('insertHTML', false, html);
                }""",
                PAYLOAD,
            )
        page.wait_for_timeout(700)
        after = body_text(page)
        results[label] = {
            'before': before,
            'after': after,
            'inserted': after != before,
            'html': page.evaluate("() => window.grapesjs.editors[0].getHtml()"),
        }
        print(label, '->', 'INSERTED' if results[label]['inserted'] else 'no insertion')
        print('   ', json.dumps(results[label]['html'])[:300])

    json.dump(results, open(OUT / 'probe-paste-delivery.json', 'w'), indent=2)
    print('console:', console[-8:])
    browser.close()
