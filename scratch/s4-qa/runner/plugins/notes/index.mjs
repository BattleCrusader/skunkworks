/**
 * S4d's reference third-party package.
 *
 * Every host operation goes through `skw.call()` — the bridge `child.mjs` installs before
 * this module is imported. The package has no filesystem, no database and no network; it
 * has one table, two settings and the five capabilities its manifest declares.
 *
 * The ops below exist so a gate can prove the interesting refusals as well as the happy
 * path: `steal` calls a host op this manifest did **not** declare, `foreign` names a table
 * that is not its own, and `peek` reads a secret setting (which must be null, never the
 * value).
 */
export async function handle(op, args = {}) {
  switch (op) {
    case 'save': {
      if (typeof args.body !== 'string' || args.body === '') throw new Error('body is required');
      const signature = await skw.call('settings.get', { key: 'signature' });
      const row = await skw.call('store.insert', {
        table: 'p_notes_note',
        row: { body: args.body, ...(typeof args.asset_key === 'string' ? { asset_key: args.asset_key } : {}) },
      });
      return { id: row.id, signature };
    }
    case 'list': {
      const rows = await skw.call('store.query', { table: 'p_notes_note', order: { column: 'body', dir: 'asc' }, limit: 10 });
      return { rows: rows.rows, count: rows.rows.length };
    }
    case 'sign': {
      await skw.call('settings.set', { key: 'signature', value: String(args.value ?? '') });
      return { ok: true };
    }
    case 'peek': {
      // A secret is write-only: the host returns null and the package cannot tell whether
      // it exists.
      return { token: await skw.call('settings.get', { key: 'api_token' }) };
    }
    case 'asset': {
      return { asset: await skw.call('assets.resolve', { key: String(args.key ?? '') }) };
    }
    case 'steal': {
      // Not declared. The host must refuse with PL_REJECTED naming the op, and the package
      // must see that refusal as a rejection.
      return await skw.call('store.delete', { table: 'p_notes_note', id: 1 });
    }
    case 'foreign': {
      // A table this package does not own. The host must refuse with PL_NO_TABLE.
      return await skw.call('store.query', { table: 'cms_page', limit: 1 });
    }
    case 'reach': {
      // The netns is the control, not the bridge: this is the package trying anyway.
      const { connect } = await import('node:net');
      return await new Promise((resolve) => {
        const socket = connect(53, '1.1.1.1');
        socket.on('connect', () => {
          socket.destroy();
          resolve('CONNECTED');
        });
        socket.on('error', (err) => resolve(err.code ?? String(err)));
      });
    }
    default:
      throw new Error(`notes: unknown op ${JSON.stringify(op)}`);
  }
}

export default handle;
