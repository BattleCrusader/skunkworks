/**
 * menu — a menu an editor can drop on a page, and the screen that fills it.
 *
 * Why this is not the site header: `cms_nav` is the *site's* bar and footer — one menu, on
 * every page, authored on the Site screen. A page sometimes needs a menu of its own: a
 * sidebar on the docs pages, a "related" strip, a section index. Those are page content, so
 * they belong in a package's own table and arrive on the page through the page builder.
 *
 * The package therefore has exactly three surfaces, and all three are declarations:
 *
 *   - `p_menu_item`, created by the host from `plugin.json` (never by this file);
 *   - the screen `/menus`, a declarative list/form the host draws — no markup from here;
 *   - `ctx.block(...)`: the palette entry. The host draws a real `<ul>` of `<a>`s from the
 *     rows, ordered by `position`, skipping `visible = 0`, and refusing an `href` that is not
 *     a site path or an `http(s)` URL (`app/render/blocks.ts`, `safeHref`). The package
 *     supplies no HTML: a block is a query plus a shape.
 *
 * `GET /_plugin/menu/items` is the same rows as JSON, so a menu can also be fetched by a
 * script. It is JSON by contract — a package returning HTML would be third-party markup on
 * the tenant's own origin.
 */

/** The host's ceiling for one block; a page menu past 20 items is a navigation problem. */
const MAX_ITEMS = 20;

export function activate(ctx) {
  ctx.screen({ path: '/menus', table: 'p_menu_item', title: 'Menus' });

  // One palette entry per menu name, because a block reads exactly one menu: the filter is
  // declared, not chosen in the editor. A package author who wants a third menu adds a third
  // `ctx.block` here; an editor who wants a different set of items edits the rows.
  for (const menu of ['main', 'footer']) {
    ctx.block({
      name: `menu-${menu}`,
      label: menu === 'main' ? 'Menu' : 'Menu: footer',
      table: 'p_menu_item',
      columns: ['label', 'href', 'menu', 'position'],
      labelColumn: 'label',
      limit: MAX_ITEMS,
      orderBy: 'position',
      order: 'asc',
      // Two conditions, both required: a hidden row is a row an editor kept on purpose, and a
      // block must not show the other menu's items either.
      filters: [
        { column: 'visible', equals: '1' },
        { column: 'menu', equals: menu },
      ],
      layout: 'list',
      // The whole cell is the URL (`safeHref` in app/render/blocks.ts): `/about` stays `/about`
      // instead of being percent-encoded as one path segment.
      href: '{href}',
    });
  }

  ctx.endpoint('GET', 'items', async (args) => {
    const query = args.query ?? {};
    const menu = typeof query.menu === 'string' ? query.menu.trim() : '';
    // `menu` and `visible` are declared `indexed` in plugin.json: the facade refuses a
    // `where` on a column the manifest did not mark, which is what keeps this a seek.
    const where = [{ column: 'visible', op: '=', value: 1 }];
    if (menu !== '') where.push({ column: 'menu', op: '=', value: menu });

    const page = await args.facade['store.read']('p_menu_item', {
      where,
      order: { column: 'position', dir: 'asc' },
      limit: MAX_ITEMS,
      offset: 0,
    });
    const rows = Array.isArray(page?.rows) ? page.rows : [];
    return {
      items: rows.map((row) => ({
        menu: String(row.menu ?? ''),
        label: String(row.label ?? ''),
        href: String(row.href ?? ''),
        position: Number(row.position ?? 0),
      })),
      count: rows.length,
    };
  });
}

export default activate;
