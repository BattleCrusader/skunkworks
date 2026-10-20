/**
 * The component registry as **data** (SDS §10.2, D21 as amended).
 *
 * One entry per component, and every consumer reads the same entry:
 *
 *   | consumer        | reads                                        |
 *   |-----------------|----------------------------------------------|
 *   | the editor      | type, label, category, html, editable        |
 *   | the renderer    | type, html, editable (asset keys → URLs)     |
 *   | the exporters   | all of it (the bundle must be self-describing) |
 *
 * The rule this file exists to keep: **the palette is generated, never written.** A test
 * adds an entry to an in-memory registry and the palette grows with no other edit; if it
 * did not, the palette would be a second list and would drift (D21's whole point).
 *
 * `parseRegistry()` is a gate, not a deserialiser. It refuses a registry whose block has
 * no `type`, whose `type` is not its `name`, whose `html` root does not carry
 * `data-gjs-type="<name>"`, whose `editable` prop does not appear in its own html, whose
 * `allowed_children` names something that is not registered, or whose `list` disagrees
 * with the table's own CHECK (§6.3). A registry that fails here is an image that would
 * have shipped a component the editor cannot round-trip.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from '../errors.ts';
import { attr, elements, parseHtml } from './html.ts';

export type Kind = 'block' | 'shell' | 'island' | 'list';
export type FieldType = 'text' | 'asset' | 'href';

export interface EditableField {
  prop: string;
  type: FieldType;
}

export interface RegistryEntry {
  name: string;
  kind: Kind;
  /** The `data-gjs-type` this component owns. Blocks: the name itself. */
  type: string;
  label: string;
  category: string;
  renderer: string;
  version: string;
  bindings: string[];
  props: Record<string, unknown>;
  repeatChild: string | null;
  limitMax: number | null;
  editable: EditableField[];
  allowedChildren: string[];
  /** The block the palette inserts. `null` for a shell (a shell is not a block). */
  html: string | null;
  css: string;
  loop?: string;
}

export interface Registry {
  version: number;
  entries: RegistryEntry[];
  byName: Map<string, RegistryEntry>;
  byType: Map<string, RegistryEntry>;
}

export interface PaletteItem {
  id: string;
  label: string;
  category: string;
  type: string;
  kind: Kind;
  content: string;
  /** The fields the settings panel offers, straight from the entry. */
  editable: EditableField[];
}

interface RawEntry {
  name?: unknown;
  kind?: unknown;
  type?: unknown;
  label?: unknown;
  category?: unknown;
  renderer?: unknown;
  version?: unknown;
  bindings?: unknown;
  props?: unknown;
  repeat_child?: unknown;
  limit_max?: unknown;
  editable?: unknown;
  allowed_children?: unknown;
  html?: unknown;
  css?: unknown;
  loop?: unknown;
}

const KINDS = new Set<Kind>(['block', 'shell', 'island', 'list']);
const FIELD_TYPES = new Set<FieldType>(['text', 'asset', 'href']);
const NAME = /^[a-z][a-z0-9-]*$/;

/**
 * GrapesJS's own component types, measured from `editor.Components.getTypes()` on 0.23.8
 * (`node scratch/gjs-types.mjs` in the S4a report). A registry type that collides with one
 * of these is not a component of ours: `addType('image', …)` does not replace the built-in
 * image model, so a `<figure data-gjs-type="image">` is parsed as GrapesJS's image and the
 * model writes a `src="data:image/svg+xml;base64,…"` placeholder into the body on save —
 * measured, and the reason this list is a refusal at boot rather than a comment.
 */
export const GRAPESJS_TYPES = new Set([
  'data-collection', 'data-collection-item', 'data-condition', 'data-condition-true-content',
  'data-condition-false-content', 'data-variable', 'cell', 'row', 'table', 'thead', 'tbody',
  'tfoot', 'map', 'link', 'label', 'video', 'image', 'script', 'svg-in', 'svg', 'iframe',
  'comment', 'textnode', 'head', 'wrapper', 'text', 'default',
]);

function bad(message: string): never {
  // A registry that cannot be parsed is an image defect, not a tenant's mistake: the
  // 500 is right, and the message names the entry so a builder can fix it.
  throw new AppError('SKW_E_PLT_INTERNAL', `component registry: ${message}`);
}

function stringArray(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) bad(`${where} must be an array of strings`);
  return raw as string[];
}

function fields(raw: unknown, where: string): EditableField[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) bad(`${where} must be an array`);
  return raw.map((f, i) => {
    const r = f as { prop?: unknown; type?: unknown };
    if (typeof r.prop !== 'string' || r.prop === '') bad(`${where}[${i}].prop must be a non-empty string`);
    if (typeof r.type !== 'string' || !FIELD_TYPES.has(r.type as FieldType)) {
      bad(`${where}[${i}].type must be one of ${[...FIELD_TYPES].join(', ')}`);
    }
    return { prop: r.prop, type: r.type as FieldType };
  });
}

export function parseRegistry(raw: unknown): Registry {
  const file = raw as { version?: unknown; components?: unknown };
  if (typeof file.version !== 'number' || !Number.isInteger(file.version)) bad('version must be an integer');
  if (!Array.isArray(file.components)) bad('components must be an array');

  const entries: RegistryEntry[] = [];
  const byName = new Map<string, RegistryEntry>();
  const byType = new Map<string, RegistryEntry>();

  for (const [index, item] of file.components.entries()) {
    const r = item as RawEntry;
    const where = `components[${index}]`;
    if (typeof r.name !== 'string' || !NAME.test(r.name)) bad(`${where}.name must match ${NAME}`);
    const name = r.name;
    if (byName.has(name)) bad(`duplicate name ${name}`);
    if (typeof r.kind !== 'string' || !KINDS.has(r.kind as Kind)) bad(`${name}.kind must be one of ${[...KINDS].join(', ')}`);
    const kind = r.kind as Kind;
    if (typeof r.renderer !== 'string' || !/^(components|islands)\//.test(r.renderer)) bad(`${name}.renderer must start components/ or islands/`);
    if (typeof r.version !== 'string' || r.version === '') bad(`${name}.version must be a string`);
    if (r.props !== undefined && (typeof r.props !== 'object' || r.props === null)) bad(`${name}.props must be an object`);

    const entry: RegistryEntry = {
      name,
      kind,
      type: typeof r.type === 'string' ? r.type : name,
      label: typeof r.label === 'string' && r.label !== '' ? r.label : name,
      category: typeof r.category === 'string' && r.category !== '' ? r.category : 'Blocks',
      renderer: r.renderer,
      version: r.version,
      bindings: r.bindings === undefined ? [] : stringArray(r.bindings, `${name}.bindings`),
      props: (r.props ?? {}) as Record<string, unknown>,
      repeatChild: r.repeat_child === undefined || r.repeat_child === null ? null : String(r.repeat_child),
      limitMax: r.limit_max === undefined || r.limit_max === null ? null : Number(r.limit_max),
      editable: fields(r.editable, `${name}.editable`),
      allowedChildren: r.allowed_children === undefined ? [] : stringArray(r.allowed_children, `${name}.allowed_children`),
      html: typeof r.html === 'string' && r.html !== '' ? r.html : null,
      css: typeof r.css === 'string' ? r.css : '',
    };
    if (typeof r.loop === 'string') entry.loop = r.loop;

    // §6.3's two CHECKs, restated where a builder sees them first.
    if (kind === 'list') {
      if (entry.repeatChild !== '[data-repeat]') bad(`${name}: a list must name repeat_child '[data-repeat]'`);
      if (entry.limitMax === null || !Number.isInteger(entry.limitMax) || entry.limitMax < 1 || entry.limitMax > 200) {
        bad(`${name}: a list must carry limit_max in 1..200`);
      }
    } else if (entry.repeatChild !== null) {
      bad(`${name}: repeat_child is only meaningful on a list`);
    }

    if (kind === 'shell') {
      if (entry.html !== null) bad(`${name}: a shell is not a block and emits no html of its own`);
    } else {
      if (entry.html === null) bad(`${name}: a ${kind} needs the html the palette inserts`);
      if (entry.type !== name) bad(`${name}: type must equal name (one vocabulary, not two)`);
      if (GRAPESJS_TYPES.has(entry.type)) {
        bad(`${name}: type "${entry.type}" is one of GrapesJS's own component types (${[...GRAPESJS_TYPES].join(', ')}) — a block cannot share a name with an editor built-in`);
      }
      if (entry.label === '' || entry.css === '') bad(`${name}: needs a label and a css rule`);
      const tree = parseHtml(entry.html);
      const roots = tree.filter((n) => n.type !== 'text' || n.text.trim() !== '');
      if (roots.length !== 1 || roots[0]?.type !== 'element') bad(`${name}.html must have exactly one root element`);
      const root = roots[0] as ReturnType<typeof parseHtml>[number];
      if (root.type !== 'element') bad(`${name}.html root is not an element`);
      if (attr(root, 'data-gjs-type') !== entry.type) {
        bad(`${name}.html root must carry data-gjs-type="${entry.type}" — a block whose lock is not in its own markup is stripped on save (measured 176 B -> 110 B)`);
      }
      const props = new Set(
        elements(tree)
          .map((el) => attr(el, 'data-prop'))
          .filter((v): v is string => v !== undefined),
      );
      for (const field of entry.editable) {
        if (!props.has(field.prop)) bad(`${name}.editable names "${field.prop}" but no element carries data-prop="${field.prop}"`);
      }
    }

    entries.push(entry);
    byName.set(name, entry);
    if (entry.kind !== 'shell') {
      if (byType.has(entry.type)) bad(`two components claim data-gjs-type="${entry.type}"`);
      byType.set(entry.type, entry);
    }
  }

  // Nesting is checked after every name exists, so the order of the file cannot matter.
  for (const entry of entries) {
    for (const child of entry.allowedChildren) {
      if (!byName.has(child)) bad(`${entry.name}.allowed_children names "${child}", which is not registered`);
      if (byName.get(child)?.kind === 'shell') bad(`${entry.name}.allowed_children names a shell ("${child}")`);
    }
  }

  return { version: file.version, entries, byName, byType };
}

export function loadRegistry(schemaDir: string): Registry {
  return parseRegistry(JSON.parse(readFileSync(join(schemaDir, 'component-registry.json'), 'utf8')));
}

/**
 * The palette, generated. Order is the registry's order, grouped by category in
 * first-seen order — the editor's block panel is this array, and adding an entry is
 * the only edit needed (§10.2: "adding a component is one file plus one JSON row").
 */
export function palette(registry: Registry): PaletteItem[] {
  return registry.entries
    .filter((e) => e.kind !== 'shell' && e.html !== null)
    .map((e) => ({
      id: e.name,
      label: e.label,
      category: e.category,
      type: e.type,
      kind: e.kind,
      content: e.html as string,
      editable: e.editable,
    }));
}

/** Categories in first-seen order, for a palette that does not jump around. */
export function paletteCategories(items: PaletteItem[]): string[] {
  const seen: string[] = [];
  for (const item of items) if (!seen.includes(item.category)) seen.push(item.category);
  return seen;
}

/** §10.1: one stylesheet per page; `cms_page.body_css` is this, in registry order. */
export function registryCss(registry: Registry): string {
  return registry.entries
    .filter((e) => e.css !== '')
    .map((e) => e.css)
    .join('\n');
}

/**
 * The GrapesJS type definitions, derived. `attributes` re-emits the lock because a
 * model whose defaults omit it drops `data-gjs-type` on save even when the type IS
 * registered (measured, R2 Runtime M2 vs M3: 110 B vs 135 B).
 */
export interface TypeDefinition {
  type: string;
  /** GrapesJS calls this with a DOM element *or* a parsed node description. */
  isComponent: (el: unknown) => boolean;
  model: unknown;
}

export function typeDefinitions(registry: Registry): TypeDefinition[] {
  return [...registry.byType.values()].map((entry) => ({
    type: entry.type,
    isComponent: (el: unknown): boolean => declaredType(el) === entry.type,
    model: {
      defaults: {
        tagName: (parseHtml(entry.html ?? '').find((n) => n.type === 'element') as { tag?: string } | undefined)?.tag ?? 'div',
        attributes: { 'data-gjs-type': entry.type },
        droppable: entry.allowedChildren.length > 0,
      },
    },
  }));
}

/**
 * The `data-gjs-type` an element or a parsed node description declares. GrapesJS's
 * `isComponent` is called with both shapes (a DOM element during a drag, a plain
 * `{ tagName, attributes }` during `setComponents`), and a definition that handles only
 * one of them silently stops matching on the other path.
 */
export function declaredType(el: unknown): string | null {
  if (el === null || typeof el !== 'object') return null;
  const dom = el as { getAttribute?: (name: string) => string | null };
  if (typeof dom.getAttribute === 'function') return dom.getAttribute('data-gjs-type');
  const parsed = el as { attributes?: Record<string, unknown> };
  const value = parsed.attributes?.['data-gjs-type'];
  return typeof value === 'string' ? value : null;
}
