/**
 * `EXPORT-NOTES.md` — the machine-readable half of a tree's manifest (§11.5).
 *
 * For the CMS bundle this file is generated from `BUNDLE.json.notes`; for the two
 * targets that have no `BUNDLE.json` it is the only manifest, so it carries the same
 * facts in the same order: the target, the tenant, the one declared timestamp, and the
 * three digests that prove all three trees came from one projection.
 *
 * **The declared timestamp.** A tree may differ between two `SKW_EXPORT_NOW` values in
 * exactly one place, and this file states which: the `exported_at:` line. Everything
 * else — every page, every byte, every symlink — is a function of the database only.
 * `test/export-determinism.test.ts` asserts that by diffing two trees, not by trusting
 * this paragraph.
 */
import type { ExportTarget, Projection } from './project.ts';

export interface NotesInput {
  target: ExportTarget;
  projection: Projection;
  /** `https://acme.test` — what a sitemap needs and a site.db does not carry. */
  origin?: string;
  /** Target-specific lines (the CMS bundle's file count, the Astro build command). */
  lines?: readonly string[];
}

const TARGET_TITLE: Record<ExportTarget, string> = {
  cms: 'CMS bundle',
  astro: 'Astro project',
  static: 'Static HTML/JS',
};

export function renderNotes(input: NotesInput): string {
  const p = input.projection;
  const out: string[] = [];
  out.push(`# Export notes — ${p.tenantKey} (${TARGET_TITLE[input.target]})`);
  out.push('');
  out.push('<!-- The two `key: value` lines below are parsed by gates. Do not reflow them. -->');
  out.push('');
  out.push(`exported_at: ${p.exportNow}`);
  out.push(`projection_sha: ${p.projectionSha}`);
  out.push(`content_sha: ${p.contentSha}`);
  out.push(`media_sha: ${p.mediaSha}`);
  out.push(`pages: ${p.pages.length}`);
  out.push(`assets: ${p.referenced.length}`);
  if (input.origin !== undefined) out.push(`origin: ${input.origin}`);
  out.push('');
  out.push('## What this export is');
  out.push('');
  out.push(
    `Every page below was produced by the site's own render path (\`renderStoredBody\` → \`renderBody\` → ` +
      `the page shell), from the bytes in \`cms_page.body_html\`, at the projection above. The three ` +
      `targets share that projection: \`projection_sha\` is the same value in a CMS bundle, an Astro ` +
      `project and a static tree made from the same database and clock.`,
  );
  out.push('');
  out.push('| path | title | body bytes | sha256 (body) |');
  out.push('|---|---|---|---|');
  for (const page of p.pages) {
    out.push(`| \`${page.path}\` | ${page.title.replace(/\|/g, '\\|')} | ${page.bodyHtml.length} | \`${page.bodySha}\` |`);
  }
  out.push('');
  if ((input.lines ?? []).length > 0) {
    out.push('## Target');
    out.push('');
    for (const line of input.lines ?? []) out.push(line);
    out.push('');
  }
  out.push('## Time');
  out.push('');
  out.push(
    '`exported_at:` above is the **only** place a date appears in this tree. Two exports of one ' +
      'database at one `SKW_EXPORT_NOW` are byte-identical; at two clocks they differ in that line ' +
      'and nothing else. A sitemap here carries no `lastmod`, because a `lastmod` would be a second ' +
      'timestamp that says something the export did not measure.',
  );
  out.push('');
  return out.join('\n');
}

/** Parse the two machine-readable lines back out, for a gate or an operator. */
export function readNotes(text: string): { exportedAt: string; projectionSha: string; origin?: string } {
  const pick = (name: string): string => {
    const match = new RegExp(`^${name}: (.*)$`, 'm').exec(text);
    return match?.[1]?.trim() ?? '';
  };
  const origin = pick('origin');
  return origin === ''
    ? { exportedAt: pick('exported_at'), projectionSha: pick('projection_sha') }
    : { exportedAt: pick('exported_at'), projectionSha: pick('projection_sha'), origin };
}
