/**
 * **Site search** — GET `/search?q=…`, answered from `cms_page` and nothing else.
 *
 * Why no index table: the corpus is a CMS's pages, which is tens, not millions. A `LIKE` scan over
 * `title`, `path` and `body_html` on a tenant whose whole site is a few megabytes reads the file
 * once and is bounded by `SEARCH_LIMIT`; an FTS5 table would add shadow tables the schema model
 * cannot express (`scripts/model/gen_schema.py` enumerates tables and every amendment is checked
 * for convergence against it), a reindex that has to be kept in step with every publish, every
 * restore and the plugin writes, and a second copy of every page body. The index buys milliseconds
 * this query does not need and costs a class of bug this file does not have.
 *
 * What it does inherit, it inherits exactly: visibility is `PAGE_VISIBLE` from
 * `app/render/visibility.ts`, so a draft, a hidden page and a page scheduled for next Tuesday are
 * all absent from results — the same predicate the renderer, the sitemap and the exporter use.
 *
 * Ranking is boring on purpose: a title match beats a path match beats a body match, then newest
 * first. No stemming, no fuzzy matching, no synonyms — a search box that finds what the page says
 * is worth more than one that guesses.
 */
import type Database from 'better-sqlite3';

import { escapeAttr, escapeText } from '../editor/html.ts';
import { PAGE_VISIBLE, visibleBefore } from './visibility.ts';

export const SEARCH_PATH = '/search';

/** Long enough for a sentence, short enough that the query never becomes the problem. */
export const SEARCH_MAX_QUERY = 120;
/** One screenful. A search that returns 900 hits has failed to answer the question. */
export const SEARCH_LIMIT = 50;

export interface SearchHit {
  path: string;
  title: string;
  /** Plain text around the first match, or the page's own opening sentence when only the title matched. */
  snippet: string;
}

export interface SearchResult {
  /** The query as it will be used — trimmed, collapsed, clipped. */
  query: string;
  hits: SearchHit[];
  /** True when there are more matches than `SEARCH_LIMIT`. */
  truncated: boolean;
}

/**
 * The query a visitor typed, made safe to bind.
 *
 * Control characters go because they are never a search term and they make a "no results" page
 * read as a bug. Whitespace collapses so `foo   bar` and `foo bar` are one search, not two.
 */
export function normaliseQuery(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_MAX_QUERY);
}

/**
 * `%term%` with the three characters `LIKE` gives meaning to escaped by a backslash.
 *
 * This is why every call site writes `ESCAPE '\'`: a visitor searching for `100%` must find the
 * page that says `100%`, not every page ever written (`%` alone matches everything), and `_` must
 * be an underscore rather than any single character.
 */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** `body_html` as the sentence a person reads: tags gone, entities decoded, space collapsed. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The words around the first match, or the opening of the page when the match was in the title.
 * Both ends are trimmed on word boundaries so a snippet never starts mid-word.
 */
export function snippetOf(text: string, query: string, width = 200): string {
  if (text === '') return '';
  const at = query === '' ? -1 : text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return clip(text, 0, width);
  // Back up a third of the window, then forward to the next space: a snippet that begins
  // mid-word ("… ms & integrations") reads as a rendering bug, not as a quotation.
  const raw = Math.max(0, at - Math.floor(width / 3));
  const space = raw === 0 ? 0 : text.indexOf(' ', raw);
  const start = space === -1 || space > at ? raw : space + 1;
  return (start > 0 ? '… ' : '') + clip(text, start, width) + (start + width < text.length ? ' …' : '');
}

function clip(text: string, start: number, width: number): string {
  const slice = text.slice(start, start + width);
  if (start === 0 && text.length <= width) return slice;
  // Cut at the last space so the snippet reads as words rather than as a torn string.
  const space = slice.lastIndexOf(' ');
  return (space > width * 0.6 ? slice.slice(0, space) : slice).trim();
}

interface Row {
  path: string;
  title: string;
  body_html: string;
  seo_json: string | null;
}

/**
 * Every visible page whose title, path or body contains the query, best match first.
 *
 * `ESCAPE '\'` appears five times because each `LIKE` is its own escape context and a parameter
 * cannot carry it — the pattern is the only thing that can.
 */
export function searchPages(db: Database.Database, query: string, now: Date = new Date()): SearchResult {
  const q = normaliseQuery(query);
  if (q === '') return { query: '', hits: [], truncated: false };
  const like = likePattern(q);
  const rows = db
    .prepare(
      `SELECT path, title, body_html, seo_json,
              CASE
                WHEN title LIKE ? ESCAPE '\\' THEN 3
                WHEN path LIKE ? ESCAPE '\\' THEN 2
                ELSE 1
              END AS rank
         FROM cms_page
        WHERE ${PAGE_VISIBLE}
          AND (title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR body_html LIKE ? ESCAPE '\\')
        ORDER BY rank DESC, updated_at DESC, path ASC
        LIMIT ?`,
    )
    // Bind order is textual: the two `rank` patterns, the visibility instant, the three match
    // patterns, then the limit. `PAGE_VISIBLE` sits between them because it is interpolated into
    // the `WHERE`, so reordering the fragment would silently shift every value after it.
    .all(like, like, visibleBefore(now), like, like, like, SEARCH_LIMIT + 1) as (Row & { rank: number })[];
  const truncated = rows.length > SEARCH_LIMIT;
  const hits = rows.slice(0, SEARCH_LIMIT).map((row) => ({
    path: row.path,
    title: row.title === '' ? row.path : row.title,
    snippet: snippetOf(plainText(row.body_html) || descriptionOf(row.seo_json), q),
  }));
  return { query: q, hits, truncated };
}

function descriptionOf(seoJson: string | null): string {
  if (seoJson === null) return '';
  try {
    const parsed = JSON.parse(seoJson) as { description?: unknown };
    return typeof parsed.description === 'string' ? parsed.description : '';
  } catch {
    return '';
  }
}

/**
 * The document. One `<form>` that works without JavaScript — the site ships no script and the
 * search page is not the place to start.
 */
export function searchBody(result: SearchResult): string {
  const form = `
  <form class="skw-search__form" role="search" action="${escapeAttr(SEARCH_PATH)}" method="get">
    <label class="skw-search__label" for="skw-q">Search this site</label>
    <div class="skw-search__row">
      <input class="skw-search__input" id="skw-q" name="q" type="search" value="${escapeAttr(result.query)}"
             maxlength="${String(SEARCH_MAX_QUERY)}" autocomplete="off" enterkeyhint="search"${result.query === '' ? ' autofocus' : ''}>
      <button class="skw-search__submit" type="submit">Search</button>
    </div>
  </form>`;

  if (result.query === '') {
    return `<section class="skw-search">
  <h1>Search</h1>
  <p class="skw-search__lede">Type a word and press Enter. Search looks at the text of every page on this site.</p>${form}
</section>`;
  }

  if (result.hits.length === 0) {
    return `<section class="skw-search">
  <h1>Nothing found</h1>
  <p class="skw-search__lede">No page on this site mentions <strong>${escapeText(result.query)}</strong>. Try a shorter word, or browse the menu.</p>${form}
</section>`;
  }

  const count =
    result.hits.length === 1 ? 'One page matches' : `${String(result.hits.length)}${result.truncated ? '+' : ''} pages match`;
  const items = result.hits
    .map(
      (hit) => `
    <li class="skw-search__hit">
      <a class="skw-search__link" href="${escapeAttr(hit.path)}">${escapeText(hit.title)}</a>
      <span class="skw-search__where">${escapeText(hit.path)}</span>
      ${hit.snippet === '' ? '' : `<p class="skw-search__snippet">${escapeText(hit.snippet)}</p>`}
    </li>`,
    )
    .join('');

  return `<section class="skw-search">
  <h1>Search</h1>${form}
  <p class="skw-search__lede">${count} <strong>${escapeText(result.query)}</strong>.${result.truncated ? ' Refine the word to narrow it down.' : ''}</p>
  <ol class="skw-search__hits">${items}
  </ol>
</section>`;
}

export function searchTitle(result: SearchResult, siteName: string): string {
  if (result.query === '') return `Search — ${siteName}`;
  return `Search: ${result.query} — ${siteName}`;
}

export function searchDescription(result: SearchResult, siteName: string): string {
  if (result.query === '') return `Search every page on ${siteName}.`;
  return `${String(result.hits.length)} page(s) on ${siteName} matching “${result.query}”.`;
}
