// R2.5 plugin probe 3 — does a plugin block survive the editor, and does it survive being disabled?
//
// grapesjs 0.23.8 + jsdom, headless. Four shapes of the same block:
//   1. placeholder only, type registered            (the design proposed in r2-plugin.md)
//   2. placeholder only, type NOT registered       (tenant disabled the plugin, page later saved)
//   3. placeholder + the plugin's rendered markup  (the "insert the form" alternative)
//   4. props carrying a closing script tag + entities
//
// Run: SK_PROBE_DEPS=<dir with grapesjs+jsdom> node scripts/debate/r2-plugin/p3_block.mjs
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const DEPS = process.env.SK_PROBE_DEPS ||
  path.join(os.homedir(), '.hermes/profiles/ceo/cache/scratch/probe/gjs');
const require = createRequire(path.join(DEPS, 'package.json'));
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="gjs"></div></body></html>',
  { pretendToBeVisual: true, url: 'http://localhost/' });
global.window = dom.window; global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement; global.Element = dom.window.Element;
global.Node = dom.window.Node; global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer; global.CSSStyleSheet = dom.window.CSSStyleSheet;
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const grapesjs = (await import(path.join(DEPS, 'node_modules/grapesjs/dist/grapes.mjs'))).default;

const PLUGIN_TYPE = {
  isComponent: (el) => el.hasAttribute && el.hasAttribute('data-plugin'),
  model: {
    defaults: {
      droppable: false,
      editable: false,
      selectable: true,
      attributes: { 'data-gjs-type': 'plugin' },
    },
  },
};

function editor(withType) {
  const ed = grapesjs.init({ headless: true, container: document.getElementById('gjs'),
    storageManager: false, fromElement: false });
  if (withType) ed.Components.addType('plugin', PLUGIN_TYPE);
  return ed;
}
const body = (s) => (s.match(/^<body>([\s\S]*)<\/body>$/) ?? [, s])[1];
const canon = (s) => s.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

function quiet(fn) {
  const out = [];
  const { log, warn, error } = console;
  console.log = console.warn = console.error = (...a) => out.push(a.map(String).join(' ').slice(0, 80));
  try { return fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
}

function roundtrip(html, withType) {
  const e1 = editor(withType);
  e1.setComponents(html);
  const o1 = body(e1.getHtml());
  const blocks = e1.getComponents().length;
  e1.destroy();
  const e2 = editor(withType);
  e2.setComponents(o1);
  const o2 = body(e2.getHtml());
  e2.destroy();
  return { o1, o2, pass1: canon(o1) === canon(html), pass2: canon(o2) === canon(o1),
    bytes: o1.length, blocks };
}

console.log('1. placeholder only, type registered');
const P = `<div data-gjs-type="plugin" data-plugin="contact" data-view="form" data-props="{&quot;title&quot;:&quot;Contact us&quot;,&quot;fields&quot;:[&quot;name&quot;,&quot;email&quot;,&quot;message&quot;]}"></div>`;

if (process.argv[2] === '--case2') {
  process.stderr.write(JSON.stringify(roundtrip(P, false)) + '\n');
  process.exit(0);
}

{
  const r = roundtrip(P, true);
  console.log('   in   :', P);
  console.log('   out1 :', r.o1);
  console.log(`   pass1==input ${r.pass1}  pass2==pass1 ${r.pass2}  bytes ${r.bytes}  top-level components ${r.blocks}`);
}

console.log('\n2. placeholder only, type NOT registered (plugin disabled, page saved afterwards)');
{
  // GrapesJS logs a full component dump on stdout when a saved type is unregistered, which
  // would drown the output this probe exists to print. Run it in a child: the dump goes to
  // the child's stdout and is discarded; the verdict comes back on stderr as one JSON line.
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--case2'],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  const r = JSON.parse(String(res.stderr).trim().split('\n').pop());
  console.log('   out1 :', r.o1);
  console.log(`   pass1==input ${r.pass1}  pass2==pass1 ${r.pass2}  bytes ${r.bytes}`);
  console.log(`   data-plugin kept? ${/data-plugin/.test(r.o1)}   data-view kept? ${/data-view/.test(r.o1)}   data-gjs-type kept? ${/data-gjs-type/.test(r.o1)}`);
}

console.log('\n3. placeholder + the plugin\'s rendered markup (the alternative: store the form)');
const RENDERED = `<div data-gjs-type="plugin" data-plugin="contact" data-view="form"><form class="plugin-form" method="post" action="/_p/contact/submit" novalidate><input type="hidden" name="_pt" value="tok_abc"><input class="plugin-form__hp" type="text" name="_hp" tabindex="-1" autocomplete="off"><label class="plugin-form__label" for="f-email">Email</label><input id="f-email" type="email" name="email" required placeholder="you@example.com"><textarea name="message" rows="5" required maxlength="4000"></textarea><button type="submit" class="btn">Send</button></form></div>`;
{
  const r = roundtrip(RENDERED, true);
  console.log('   out1 :', r.o1.replace(/></g, '>\n          <').slice(0, 1200));
  const keep = ['<form', 'action="/_p/contact/submit"', 'method="post"', 'type="hidden"', 'name="_pt"',
    'required', 'placeholder=', 'maxlength=', 'rows=', 'novalidate', 'tabindex='];
  console.log('   surviving:', keep.map((k) => `${k}:${r.o1.includes(k)}`).join(' '));
  console.log(`   pass1==input ${r.pass1}  pass2==pass1 ${r.pass2}  bytes ${r.bytes}`);
}

console.log('\n4. props carrying a closing script tag, an angle bracket and entities');
const XSS = `<div data-gjs-type="plugin" data-plugin="contact" data-view="form" data-props="{&quot;title&quot;:&quot;a&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&quot;}"></div>`;
{
  const r = roundtrip(XSS, true);
  console.log('   in   :', XSS);
  console.log('   out1 :', r.o1);
  console.log(`   literal "</script>" in stored output? ${r.o1.includes('</script>')}   "<img" present? ${r.o1.includes('<img')}`);
}

console.log('\n5. one page, K plugin blocks (marginal stored bytes and editor cost)');
for (const k of [1, 4, 16]) {
  const many = Array.from({ length: k }, (_, i) =>
    `<div data-gjs-type="plugin" data-plugin="contact" data-view="form" data-props="{&quot;i&quot;:${i}}"></div>`).join('');
  const t0 = process.hrtime.bigint();
  const e = editor(true); e.setComponents(many); const out = body(e.getHtml()); e.destroy();
  const t1 = process.hrtime.bigint();
  console.log(`   k=${String(k).padStart(2)}  stored=${String(out.length).padStart(5)} B  load=${(Number(t1 - t0) / 1e6).toFixed(2)} ms  marginal=${k > 1 ? ((out.length - 176) / (k - 1)).toFixed(0) : '-'} B/block`);
}
