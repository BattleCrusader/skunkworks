/**
 * The reference third-party package, **D36 shape** (§13.3.2, §13.3.4).
 *
 * A package is a module that exports `activate(ctx)`. Everything it can do to the host happens
 * through two doors, and both are given to it here:
 *
 *   - `ctx.on(hook, fn)` — the twelve hooks, and only those the manifest declared;
 *   - the per-request **facade** inside an endpoint handler — `args.facade`, rebuilt per
 *     request, bound to the tenant that request resolved, with the capability check in front of
 *     every call.
 *
 * The module also keeps a module-level counter. That counter is the point of the cache-buster:
 * disable→enable must give a **new module instance**, so `activationCount()` starts at 0 again
 * (§13.3.2, L8–L9). If it did not, Node's ESM cache would be handing back the old namespace with
 * its old timers, and "not loaded" would be a lie.
 *
 * The extra ops exist so a gate can prove the refusals as well as the happy path: `steal` calls
 * a facade method the manifest did not declare, `foreign` names a table that is not its own, and
 * `peek` reads a secret setting (which must be null, never the value).
 */
let activations = 0;

export function activate(ctx) {
  activations += 1;

  ctx.on('content.render.html', async (call, html) => {
    // A filter's return value replaces only the value it was handed: `html`, nothing else.
    // There is no status, no header and no route in this signature to change.
    // `activations` is module-level state: the comment carries it so a gate can *see* that a
    // disable→enable cycle produced a new module instance (§13.3.2, L9).
    return `${html}\n<!-- notes:${call.tenant}:act=${activations}:${String(call.path ?? '')} -->`;
  });

  ctx.on('page.head', async () => '<meta name="notes" content="on">');

  ctx.endpoint('GET', 'list', async (args) => {
    const rows = await args.facade['store.read']('p_notes_note', { order: { column: 'body', dir: 'asc' }, limit: 10 });
    return { rows: rows.rows, count: rows.rows.length, tenant: args.facade === undefined ? null : null };
  });

  ctx.endpoint('POST', 'sign', async (args) => {
    const value = typeof args.body === 'string' ? args.body : '';
    await args.facade['settings.set']('signature', value);
    return { ok: true };
  });
}

/** How many times this module instance has been activated. Always 1 for a fresh instance. */
export function activationCount() {
  return activations;
}

/**
 * The pre-D36 entry point, kept because the install-time test runner and the packaging tools
 * still call it. Under D36 nothing routes through `handle`: endpoints are registered at
 * activation, and `op` here is only used by `manifest.tests`.
 */
export async function handle(op, args = {}, facade) {
  switch (op) {
    case 'save': {
      if (typeof args.body !== 'string' || args.body === '') throw new Error('body is required');
      const signature = await facade['settings.get']('signature');
      const row = await facade['store.write']('p_notes_note', {
        body: args.body,
        ...(typeof args.asset_key === 'string' ? { asset_key: args.asset_key } : {}),
      });
      return { id: row.id, signature };
    }
    case 'list': {
      return await facade['store.read']('p_notes_note', { order: { column: 'body', dir: 'asc' }, limit: 10 });
    }
    case 'sign': {
      await facade['settings.set']('signature', String(args.value ?? args.body ?? ''));
      return { ok: true };
    }
    case 'peek':
      return { token: await facade['settings.get']('api_token') };
    case 'asset':
      return { asset: await facade['assets.resolve'](String(args.key ?? '')) };
    case 'steal':
      // Not declared. The facade must refuse with PL_REJECTED naming the capability, and the
      // package must see that refusal as a rejection.
      return await facade['store.delete']('p_notes_note', 1);
    case 'foreign':
      // A table this package does not own. The host must refuse with PL_NO_TABLE.
      return await facade['store.read']('cms_page', { limit: 1 });
    default:
      throw new Error(`notes: unknown op ${JSON.stringify(op)}`);
  }
}

export default activate;
