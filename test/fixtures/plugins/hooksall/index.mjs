/**
 * The hook-wiring package (§13.3.4).
 *
 * Every callback does exactly two things:
 *
 *   1. appends `{hook, call, value}` to the JSONL file `process.env.SKW_HOOK_TRACE` names —
 *      so a gate can assert the **arguments** the host passed, which is the half of "the hook
 *      fires" that a return value alone cannot prove;
 *   2. returns something visibly different from what it was handed, or (for an action) writes
 *      the one side effect its contract allows — so the gate can assert the **effect** at the
 *      call site: the head markup in the served HTML, the rewritten `src=`, the refused
 *      submission, the added menu entry, the extra mail variable.
 *
 * The file is the fixture's channel and nothing in `app/` reads it. A test-only package that
 * could not tell a gate what it observed would force the gate to assert a side effect that the
 * product does not have — a second, invented product — which is the failure this file exists to
 * avoid.
 *
 * `import('node:fs')` is available because a plugin runs in the app's process (D36, §13.3.7).
 * Nothing here pretends otherwise.
 */
import { appendFileSync } from 'node:fs';

let activations = 0;

function trace(hook, call, value) {
  const path = process.env.SKW_HOOK_TRACE;
  if (typeof path !== 'string' || path === '') return;
  appendFileSync(path, `${JSON.stringify({ hook, call, value: value === undefined ? null : value })}\n`);
}

export function activate(ctx) {
  activations += 1;

  // --- filters: the return value replaces the named value and nothing else ---------------

  ctx.on('content.render.html', (call, html) => {
    trace('content.render.html', call, html);
    return `${html}\n<p data-hook="content">content.render.html</p>`;
  });

  ctx.on('page.head', (call) => {
    trace('page.head', call, null);
    return '<meta name="hooksall" content="page.head">';
  });

  ctx.on('asset.url', (call) => {
    trace('asset.url', call, call.url);
    // Root-relative, which is what §13.3.4's row permits. A hook returning anything else is a
    // counted failure and the original URL is used — that branch is a different gate.
    return String(call.url).replace('/media/', '/media/cdn/');
  });

  ctx.on('form.validate', (call) => {
    trace('form.validate', call, null);
    // Core accepted it unless the address is this one; a plugin may refuse what core accepted.
    const email = call.values?.email;
    if (email === 'blocked@example.com') {
      return { ok: false, errors: [{ field: 'email', message: 'this address cannot be used' }] };
    }
    return { ok: true };
  });

  ctx.on('admin.menu', (call) => {
    trace('admin.menu', call, null);
    return [
      ...call.items,
      // A declared screen: kept, because `activate` registered it below.
      { href: `/admin/t/${call.tenant}/hooks-screen`, label: 'Hook messages' },
      // Not a declared screen: dropped by the dispatch, not by this package.
      { href: `/admin/t/${call.tenant}/not-a-screen`, label: 'Should be dropped' },
    ];
  });

  ctx.on('mail.template', (call) => {
    trace('mail.template', call, null);
    // `pad: 'yes'` is the return-value **effect** witness: the host measures the object this
    // filter returned (32 KiB cap in `hostOp('mail.send')`), so a padded answer turns a valid
    // send into `SKW_E_PL_MAIL: vars exceed 32 KiB`. Without that, "the hook fired" would be
    // provable and "the value it returned was used" would not.
    if (call.vars?.pad === 'yes') return { ...call.vars, pad: 'x'.repeat(33_000) };
    return { ...call.vars, hooksall_added: 'yes' };
  });

  // --- actions: return value discarded, side effects only -------------------------------

  ctx.on('page.rendered', (call) => {
    trace('page.rendered', call, null);
    // A return value that must be ignored: if the host ever used it, the served page would
    // change shape and the gate that asserts the body would notice.
    return 'IGNORED-BY-CONTRACT';
  });

  ctx.on('form.submitted', (call) => {
    trace('form.submitted', call, null);
  });

  ctx.on('download.redeemed', (call) => {
    trace('download.redeemed', call, null);
  });

  ctx.on('admin.login', (call) => {
    trace('admin.login', call, null);
  });

  ctx.on('plugin.enabled', (call) => {
    trace('plugin.enabled', call, null);
  });

  ctx.on('plugin.disabled', (call) => {
    trace('plugin.disabled', call, null);
  });

  // A declarative screen against the package's own table: what `admin.menu` is allowed to link.
  ctx.screen({ path: '/hooks-screen', table: 'p_hooksall_message', title: 'Hook messages' });

  // An endpoint so a gate can ask the running process what it observed without the file.
  ctx.endpoint('GET', 'trace', (args) => ({
    plugin: 'hooksall',
    activations,
    tenant: args.ctx.tenant,
  }));
}

/** Module-level state: a fresh instance after disable→enable reads 1 (§13.3.2, L9). */
export function activationCount() {
  return activations;
}

export default activate;
