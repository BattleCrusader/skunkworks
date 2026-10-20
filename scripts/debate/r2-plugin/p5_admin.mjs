// R2.5 plugin probe 5 — the declarative admin surface: what it costs to render, validate and boot.
//
// The admin renderer here is ~60 lines of string building from a manifest spec. That is the point:
// the cost of declarative is visible in the probe, and the cost of the code alternative is a build.
//
// Run: node scripts/debate/r2-plugin/p5_admin.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WORK = process.env.SK_PLUGIN_WORK ||
  path.join(os.homedir(), '.hermes/profiles/ceo/cache/scratch/pluginprobe/work');
fs.mkdirSync(WORK, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- the spec a plugin declares, and nothing else --------------------------------
const FORM = {
  key: 'message', title: 'Contact messages', table: 'p_contact_message', row_key: 'id',
  list: {
    columns: [
      { col: 'ts', label: 'Received', kind: 'datetime', width: 18 },
      { col: 'name', label: 'Name', kind: 'text', width: 20 },
      { col: 'email', label: 'Email', kind: 'text', width: 24 },
      { col: 'message', label: 'Message', kind: 'text', width: 40, truncate: 80 },
      { col: 'state', label: 'State', kind: 'enum', values: ['new', 'read', 'spam'] },
      { col: 'ip_hash', label: 'IP', kind: 'text', width: 12, truncate: 8 },
    ],
    order: [{ col: 'ts', dir: 'desc' }], page_size: 50, actions: ['mark_read', 'mark_spam'],
  },
  form: {
    fields: [
      { name: 'name', kind: 'text', label: 'Name', required: true, max: 120 },
      { name: 'email', kind: 'email', label: 'Email', required: true, max: 320 },
      { name: 'message', kind: 'textarea', label: 'Message', required: true, max: 4000, rows: 8 },
      { name: 'state', kind: 'select', label: 'State', values: ['new', 'read', 'spam'], default: 'new' },
      { name: 'note', kind: 'textarea', label: 'Internal note', max: 500, rows: 3 },
      { name: 'tags', kind: 'text', label: 'Tags', max: 200 },
      { name: 'notify', kind: 'bool', label: 'Notify me', default: true },
      { name: 'received_from', kind: 'datetime', label: 'Received', readonly: true },
      { name: 'priority', kind: 'int', label: 'Priority', min: 0, max: 9, default: 0 },
      { name: 'attachment', kind: 'asset', label: 'Attachment', optional: true },
      { name: 'assignee', kind: 'text', label: 'Assignee', max: 120 },
      { name: 'internal_ref', kind: 'text', label: 'Internal ref', max: 40, readonly: true },
    ],
  },
};

// ---- the renderer ---------------------------------------------------------------
function renderField(f, value = '') {
  const id = `f-${f.name}`;
  const common = `id="${id}" name="${esc(f.name)}"${f.required ? ' required' : ''}` +
    `${f.readonly ? ' readonly' : ''}${f.max ? ` maxlength="${f.max}"` : ''}`;
  const label = `<label class="adm-label" for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>`;
  switch (f.kind) {
    case 'textarea':
      return `<div class="adm-row">${label}<textarea class="adm-input" ${common} rows="${f.rows || 4}">${esc(value)}</textarea></div>`;
    case 'select':
      return `<div class="adm-row">${label}<select class="adm-input" ${common}>` +
        f.values.map((v) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(v)}</option>`).join('') +
        '</select></div>';
    case 'bool':
      return `<div class="adm-row adm-row--check"><input type="checkbox" ${common}${value ? ' checked' : ''}>${label}</div>`;
    case 'int':
      return `<div class="adm-row">${label}<input class="adm-input" type="number" ${common} min="${f.min ?? ''}" max="${f.max ?? ''}" value="${esc(value)}"></div>`;
    case 'email':
      return `<div class="adm-row">${label}<input class="adm-input" type="email" ${common} value="${esc(value)}"></div>`;
    case 'datetime':
      return `<div class="adm-row">${label}<input class="adm-input" type="datetime-local" ${common} value="${esc(value)}"></div>`;
    case 'asset':
      return `<div class="adm-row">${label}<div class="adm-picker" data-picker="asset" data-target="${id}">` +
        `<input class="adm-input" ${common} value="${esc(value)}" placeholder="asset key"></div></div>`;
    default:
      return `<div class="adm-row">${label}<input class="adm-input" type="text" ${common} value="${esc(value)}"></div>`;
  }
}

function renderForm(spec, values = {}) {
  const rows = spec.form.fields.map((f) => renderField(f, values[f.name] ?? f.default ?? '')).join('');
  return `<form class="adm-form" method="post" data-form="${esc(spec.key)}"><input type="hidden" name="_csrf" value="tok">${rows}<div class="adm-actions"><button class="btn" type="submit">Save</button></div></form>`;
}

function renderList(spec, rows) {
  const head = spec.list.columns.map((c) => `<th style="width:${c.width || 10}%">${esc(c.label)}</th>`).join('');
  const body = rows.map((r, i) => `<tr data-id="${esc(r[spec.row_key])}">` + spec.list.columns.map((c) => {
    let v = r[c.col] ?? '';
    if (c.truncate && String(v).length > c.truncate) v = String(v).slice(0, c.truncate) + '…';
    return c.kind === 'enum'
      ? `<td><span class="adm-pill" data-v="${esc(v)}">${esc(v)}</span></td>`
      : `<td>${esc(v)}</td>`;
  }).join('') + '</tr>').join('');
  return `<table class="adm-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
    `<nav class="adm-pager">1 2 3 … 7</nav>`;
}

// ---- validation against the same spec ------------------------------------------
function validate(spec, input) {
  const errs = [];
  for (const f of spec.form.fields) {
    if (f.readonly) continue;
    const raw = input[f.name];
    if (raw === undefined || raw === '') { if (f.required) errs.push(`${f.name}:required`); continue; }
    const s = String(raw);
    if (f.max && s.length > f.max) errs.push(`${f.name}:max`);
    if (f.kind === 'int') {
      const n = Number(s);
      if (!Number.isInteger(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) errs.push(`${f.name}:range`);
    }
    if (f.kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) errs.push(`${f.name}:email`);
    if (f.kind === 'select' && !f.values.includes(s)) errs.push(`${f.name}:enum`);
  }
  return errs;
}

// ---- manifest validation (the boot cost) ----------------------------------------
const STATES = new Set(['new', 'read', 'spam']);
function validateManifest(m) {
  const e = [];
  const idOk = typeof m.id === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(m.id);
  if (!idOk) e.push('id');
  if (!/^\d+\.\d+\.\d+$/.test(m.version || '')) e.push('version');
  if (!(m.requires && /^[><=^~ ]*\d+\.\d+\.\d+$/.test(m.requires.cms || ''))) e.push('requires.cms');
  for (const t of m.tables || []) {
    if (!t.name.startsWith(`p_${m.id}_`)) e.push(`table:${t.name}`);
    if (!['rows', 'empty', 'filtered'].includes(t.export)) e.push(`export:${t.name}`);
  }
  for (const ep of m.endpoints || []) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(ep.key)) e.push(`endpoint:${ep.key}`);
    if (!['anonymous', 'session', 'code'].includes(ep.auth)) e.push(`auth:${ep.key}`);
    if (!(ep.methods || []).every((x) => ['GET', 'POST'].includes(x))) e.push(`methods:${ep.key}`);
    if (ep.auth === 'anonymous' && !ep.limits) e.push(`limits:${ep.key}`);
  }
  return e;
}

const manifest = {
  id: 'contact', version: '1.0.0', requires: { cms: '^2.0.0' },
  tables: [
    { name: 'p_contact_message', export: 'rows', pii: true },
    { name: 'p_contact_setting', export: 'rows', pii: false },
  ],
  settings: { schema: 'settings.schema.json' },
  endpoints: [{ key: 'submit', methods: ['POST'], auth: 'anonymous', limits: { per_ip: 5, window_s: 600, bytes: 16384 } }],
  blocks: [{ key: 'form', view: 'form', props: 'form.props.schema.json' }],
  admin: { list: 'list.json', form: 'form.json' },
  export: { static: { mode: 'forward', requires: 'action_url' }, astro: { mode: 'forward', requires: 'action_url' }, cms: 'native' },
};
const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
const specBytes = Buffer.byteLength(JSON.stringify(FORM));

const rows = Array.from({ length: 50 }, (_, i) => ({
  id: i + 1, ts: '2026-10-20T11:0' + (i % 10) + ':00.000Z', name: `Person ${i}`,
  email: `p${i}@example.com`, message: 'A reasonably long enquiry about a website. '.repeat(3),
  state: ['new', 'read', 'spam'][i % 3], ip_hash: 'a1b2c3d4'.repeat(8),
}));
const values = { name: 'Ada', email: 'ada@example.com', message: 'Hello', state: 'new', priority: '3', notify: 'on' };

const time = (label, fn, n = 1000) => {
  fn(); // warm
  const t0 = process.hrtime.bigint();
  let out;
  for (let i = 0; i < n; i++) out = fn();
  const t1 = process.hrtime.bigint();
  console.log(`   ${label.padEnd(42)} ${(Number(t1 - t0) / n / 1000).toFixed(1)} us   ${String(out).length} B`);
  return out;
};

console.log(`manifest ${manifestBytes} B   list+form spec ${specBytes} B   (the whole admin surface of the plugin)`);

console.log('\n1. declarative render cost (n=1000, warm)');
time('form: 12 fields', () => renderForm(FORM, values));
time('list: 50 rows x 6 columns', () => renderList(FORM, rows));
time('validate one submission against the spec', () => JSON.stringify(validate(FORM, values)));

console.log('\n2. is the spec the contract? same input, three payloads');
for (const [label, input] of Object.entries({
  'valid': values,
  'missing required': { ...values, email: '' },
  'too long': { ...values, message: 'x'.repeat(4001) },
  'enum escape': { ...values, state: 'new" onmouseover="alert(1)' },
  'int out of range': { ...values, priority: '42' },
})) {
  const errs = validate(FORM, input);
  console.log(`   ${label.padEnd(18)} -> ${errs.length ? errs.join(',') : 'ok'}`);
}

console.log('\n3. manifest validation at boot');
const t0 = process.hrtime.bigint();
const one = validateManifest(manifest);
const t1 = process.hrtime.bigint();
console.log(`   one manifest: ${one.length ? one : 'valid'} in ${(Number(t1 - t0) / 1000).toFixed(1)} us`);
const many = Array.from({ length: 20 }, (_, i) => ({ ...manifest, id: `p${i}` ,
  tables: manifest.tables.map((t) => ({ ...t, name: t.name.replace('p_contact_', `p_p${i}_`) })) }));
const t2 = process.hrtime.bigint();
const errs = many.map(validateManifest).flat();
const t3 = process.hrtime.bigint();
console.log(`   20 manifests: ${errs.length} error(s) in ${(Number(t3 - t2) / 1e6).toFixed(2)} ms (${manifestBytes * 20} B of JSON parsed+checked)`);

console.log('\n4. boot cost of 20 in-tree plugin modules (compiled with the app, not import()ed from a tenant dir)');
{
  const dir = path.join(WORK, 'mods');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(dir, `p${i}.mjs`),
      `export const id='p${i}';\nexport function register(ctx){ ctx.block('form',()=>'<form></form>'); ` +
      `ctx.endpoint('submit',{}); ctx.admin({list:{},form:{}}); }\n` +
      '// padding to a realistic module size\n' + '// x\n'.repeat(120));
  }
  const t0 = process.hrtime.bigint();
  const mods = await Promise.all(Array.from({ length: 20 }, (_, i) => import(path.join(dir, `p${i}.mjs`))));
  const t1 = process.hrtime.bigint();
  const bytes = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  console.log(`   ${mods.length} modules, ${bytes} B of source: ${(Number(t1 - t0) / 1e6).toFixed(1)} ms cold import (ESM parse+link)`);
}

console.log('\n5. what a bad manifest is refused for (first failure stops the plugin, not the boot)');
const bad = [
  { label: 'table outside its namespace', m: { ...manifest, tables: [{ name: 'u_contact_message', export: 'rows' }] } },
  { label: 'table with no export class', m: { ...manifest, tables: [{ name: 'p_contact_message' }] } },
  { label: 'anonymous endpoint with no limits', m: { ...manifest, endpoints: [{ key: 'submit', methods: ['POST'], auth: 'anonymous' }] } },
  { label: 'endpoint auth not in the enum', m: { ...manifest, endpoints: [{ key: 'submit', methods: ['POST'], auth: 'cookie' }] } },
  { label: 'requires.cms missing', m: { ...manifest, requires: {} } },
];
for (const { label, m } of bad) console.log(`   ${label.padEnd(34)} -> ${validateManifest(m).join(',') || 'ACCEPTED'}`);
