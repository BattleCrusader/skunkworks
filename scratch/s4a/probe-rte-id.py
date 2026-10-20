"""Probe 5: does opening the rich-text editor change the stored bytes on every save?

GrapesJS stamps an `id` on a text element when its RTE opens. If that id is stable across
sessions the stored bytes stay a fixpoint and the stamp is cosmetic; if it is regenerated,
then every page an operator edits by double-clicking a paragraph stops being a fixpoint —
which S4b has to know. Measures save -> reload -> RTE -> save twice.
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
DB = STATE['siteDb']
PATH = '/rte-id'


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
    raise RuntimeError('no canvas frame')


def stored():
    con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    try:
        return con.execute('SELECT id, rev, body_html FROM cms_page WHERE path = ?', (PATH,)).fetchone()
    finally:
        con.close()


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

    # A page seeded through the route, then opened and edited only by clicking into the text.
    page.goto(BASE + '/admin/t/acme/editor')
    ready(page)
    page.click('#skw-blocks button[data-type="prose"]')
    page.wait_for_timeout(400)
    seeded = page.evaluate(
        """async (path) => {
            const boot = JSON.parse(document.getElementById('skw-editor-boot').textContent);
            const r = await fetch('/admin/t/acme/editor/save', {
                method: 'POST', credentials: 'same-origin',
                headers: {'content-type': 'application/json', 'x-csrf-token': boot.csrf},
                body: JSON.stringify({path, title: 'RTE', template: 'page',
                                      html: window.grapesjs.editors[0].getHtml()}),
            });
            return await r.json();
        }""",
        PATH,
    )
    page_id = seeded['id']
    a = stored()[2]

    rounds = []
    for i in range(2):
        page.goto(f'{BASE}/admin/t/acme/editor?page={page_id}')
        ready(page)
        frame = canvas_frame(page)
        frame.dblclick('[data-prop="body"]', timeout=8000)
        page.wait_for_timeout(400)
        page.mouse.click(1330, 300)   # end the RTE
        page.wait_for_timeout(500)
        saved = page.evaluate("() => window.skwSave()")
        rounds.append({'round': i + 1, 'stored': stored()[2], 'save': {'rev': saved.get('rev')}})
        print(f'round {i + 1}:', json.dumps(stored()[2]))

    print('A :', json.dumps(a))
    print('A == round1:', a == rounds[0]['stored'], '| round1 == round2:', rounds[0]['stored'] == rounds[1]['stored'])
    json.dump({'seeded': a, 'rounds': rounds,
               'stable': a == rounds[0]['stored'] == rounds[1]['stored']},
              open(OUT / 'probe-rte-id.json', 'w'), indent=2)
    browser.close()
