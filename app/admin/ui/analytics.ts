/**
 * The Analytics screen: what happened on this site, drawn as one document.
 *
 * No client JavaScript. Every chart is an SVG path computed here, from the numbers
 * `readAnalytics()` returned — which means the screen works on a box where the browser blocks
 * scripts, is readable by a screen reader through the `<table>` under each chart, and cannot
 * leak a number into a DOM the operator did not ask for. The admin document's CSP would allow a
 * `<script>` with the per-response nonce, and it is deliberately not used: a chart does not need
 * to be interactive to be useful, and the thing an operator wants from this screen is a number
 * they can trust, not a tooltip.
 *
 * The layout is Google Analytics' shape because that shape is learned: headline numbers, one
 * trend, then "which pages", "which links", "where from", "on what". The words are this product's
 * own — "People" not "Users", "Sessions" spelled out — and every table states what it counts in
 * its heading, because "Clicks 41" with no unit is a number an operator has to guess at.
 */
import { esc, plural } from './html.ts';
import { layout, type NavItem } from './layout.ts';
import type { AnalyticsReport, AnalyticsRange } from '../analytics.ts';

export interface AnalyticsScreenInput {
  tenant: { key: string; label: string };
  user: { email: string; role: string } | null;
  report: AnalyticsReport;
  /** The range the operator asked for, so the pills can mark it. */
  range: AnalyticsRange;
  notices?: number;
}

/** `1,234` — grouped thousands, no locale dependency (this runs on the server, once). */
function num(n: number): string {
  const whole = Math.round(n);
  const sign = whole < 0 ? '-' : '';
  const digits = String(Math.abs(whole));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return sign + out;
}

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(Math.round(value * 1000) / 10).toString()}%`;
}

function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** `2026-11-17` → `17 Nov`. Short, and unambiguous in a 90-day chart. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDay(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) return day;
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`;
}

/** A path on the site, shown with its depth so a long tail reads as one. */
function pathCell(path: string): string {
  const label = path === '' ? '/' : path;
  return `<span class="an-path">${esc(label)}</span>`;
}

/**
 * The trend, as SVG. Two series on one axis — pageviews as an area, people as a line — because
 * the question "did the site get busier, or did the same few people come back more?" is answered
 * by the gap between them, and two stacked charts would not show a gap.
 */
function trendChart(report: AnalyticsReport): string {
  const points = report.series;
  const w = 720;
  const h = 210;
  const padL = 38;
  const padR = 10;
  const padT = 12;
  const padB = 26;
  if (points.length === 0) {
    return `<p class="an-empty">No pageviews in this window yet.</p>`;
  }
  const max = Math.max(1, ...points.map((p) => Math.max(p.pageviews, p.visitors)));
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const xAt = (i: number): number => (points.length === 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW);
  const yAt = (value: number): number => padT + plotH - (value / max) * plotH;

  // A y axis a person can read: whole numbers when the site is small, and never two ticks with the
  // same label. `max * 0.25` on a maximum of 2 used to print "2, 2, 1, 1, 0".
  const step = max <= 4 ? 1 : Math.max(1, Math.ceil(max / 4));
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  const grid = ticks
    .map((value) => {
      const y = yAt(value).toFixed(1);
      return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" class="an-grid"/><text x="${padL - 6}" y="${y}" class="an-axis" text-anchor="end" dominant-baseline="middle">${num(value)}</text>`;
    })
    .join('');

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.pageviews).toFixed(1)}`).join(' ');
  const area =
    points.length === 1
      ? ''
      : `${line} L${xAt(points.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${xAt(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const people = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.visitors).toFixed(1)}`).join(' ');
  // Dots: a single day of data is one point, and a `path` with one `M` in it draws nothing —
  // a chart that looks empty on the day a site goes live reads as a broken chart.
  const dots =
    points.length <= 31
      ? points
          .map(
            (p, i) =>
              `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.pageviews).toFixed(1)}" r="2.6" class="an-dot"/>` +
              `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.visitors).toFixed(1)}" r="2.2" class="an-dot an-dot--people"/>`,
          )
          .join('')
      : '';
  const first = points[0];
  const last = points[points.length - 1];
  const mid = points[Math.floor(points.length / 2)];
  const tick = (p: { day: string } | undefined, anchor: string, i: number): string =>
    p === undefined ? '' : `<text x="${xAt(i).toFixed(1)}" y="${h - 8}" class="an-axis" text-anchor="${anchor}">${esc(shortDay(p.day))}</text>`;
  return `<figure class="an-fig">
  <svg viewBox="0 0 ${w} ${h}" class="an-svg" role="img" aria-label="Pageviews and people per day, ${num(report.totals.pageviews)} pageviews and ${num(report.totals.visitors)} people over ${plural(points.length, 'day')}.">
    ${grid}
    ${area === '' ? '' : `<path d="${area}" class="an-area"/>`}
    <path d="${line}" class="an-line"/>
    <path d="${people}" class="an-line an-line--people"/>
    ${dots}
    ${tick(first, 'start', 0)}${points.length > 2 ? tick(mid, 'middle', Math.floor(points.length / 2)) : ''}${points.length > 1 ? tick(last, 'end', points.length - 1) : ''}
  </svg>
  <figcaption class="an-legend"><span class="an-key an-key--pv"></span>Pageviews<span class="an-key an-key--ppl"></span>People</figcaption>
  <table class="an-table an-table--compact">
    <caption class="an-sr">Pageviews and people per day</caption>
    <thead><tr><th scope="col">Day</th><th scope="col" class="an-num">Pageviews</th><th scope="col" class="an-num">People</th></tr></thead>
    <tbody>${points
      .slice(-7)
      .map((p) => `<tr><th scope="row">${esc(shortDay(p.day))}</th><td class="an-num">${num(p.pageviews)}</td><td class="an-num">${num(p.visitors)}</td></tr>`)
      .join('')}</tbody>
  </table>
  </figure>`;
}

/** A bar in a table cell. Width is data, so it is an inline style — allowed by `style-src-attr`. */
function barCell(value: number, max: number): string {
  const width = max <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return `<span class="an-bar"><span class="an-bar__fill" style="width:${width}%"></span></span>`;
}

function table(head: string[], rows: string[][], caption: string, empty: string): string {
  if (rows.length === 0) return `<p class="an-empty">${esc(empty)}</p>`;
  return `<table class="an-table">
  <caption class="an-sr">${esc(caption)}</caption>
  <thead><tr>${head.map((cell, i) => `<th scope="col"${i === 0 ? '' : ' class="an-num"'}>${esc(cell)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((cells) => `<tr>${cells.map((cell, i) => (i === 0 ? `<th scope="row">${cell}</th>` : `<td class="an-num">${cell}</td>`)).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

function kpi(label: string, value: string, hint?: string): string {
  return `<div class="an-kpi">
  <p class="an-kpi__label">${esc(label)}</p>
  <p class="an-kpi__value">${esc(value)}</p>
  ${hint === undefined ? '' : `<p class="an-kpi__hint">${esc(hint)}</p>`}
</div>`;
}

/**
 * The empty state, and it is not an error: a site that has not installed the package has no
 * table to read, and the operator who can fix that is the one reading this.
 */
function notInstalled(base: string): string {
  return `<div class="card an-emptycard">
  <h2>Analytics is not switched on for this site</h2>
  <p>This screen reads the <code>analytics</code> package's own table. Install it once and it starts
  recording: pageviews, which links people press, where they came from, and whether they come back.</p>
  <ol class="an-steps">
    <li>Open <a href="${esc(base)}/plugins">Plugins</a>.</li>
    <li>Find <b>analytics</b> under the packages available on this box and install it.</li>
    <li>Press <b>Enable</b>. Nothing is recorded until it is enabled, and nothing is recorded on
      pages served before the next page load.</li>
  </ol>
  <p class="an-fine">No cookies. No visitor is identified by name, address or network. The script is
  first-party, served from this site's own origin, and it is served only to a browser that asks for
  it — a crawler that does not run JavaScript is not counted.</p>
</div>`;
}

export function analyticsScreen(input: AnalyticsScreenInput): string {
  const base = `/admin/t/${encodeURIComponent(input.tenant.key)}`;
  const report = input.report;
  // No extra app-bar entry: `Analytics` is a core `NavKey` now, so `layout()` draws it on every
  // screen. Adding it here as well put two identical links in the bar.
  const nav: NavItem[] = [];
  if (!report.installed) {
    return layout({
      title: `${input.tenant.key} — analytics`,
      tenant: input.tenant,
      user: input.user,
      active: 'none',
      nav,
      ...(input.notices === undefined ? {} : { notices: input.notices }),
      body: `    <div class="pagehead"><div><h1>Analytics</h1><p>How this site is being read.</p></div></div>
${notInstalled(base)}`,
    });
  }

  const totals = report.totals;
  const maxPage = Math.max(1, ...report.topPages.map((p) => p.pageviews));
  const maxClick = Math.max(1, ...report.clicks.map((c) => c.clicks));
  const maxSource = Math.max(1, ...report.sources.map((s) => s.pageviews));
  const deviceTotal = report.devices.reduce((sum, d) => sum + d.visitors, 0);
  const returning = report.newReturning.reduce((sum, d) => sum + d.returningVisitors, 0);
  const fresh = report.newReturning.reduce((sum, d) => sum + d.newVisitors, 0);
  const returningShare = fresh + returning === 0 ? null : returning / (fresh + returning);

  const rangePills = `<nav class="an-pills" aria-label="Date range">${[7, 30, 90]
    .map(
      (d) =>
        `<a href="${esc(base)}/analytics?days=${String(d)}"${d === report.days ? ' aria-current="page"' : ''}>${String(d)} days</a>`,
    )
    .join('')}</nav>`;

  return layout({
    title: `${input.tenant.key} — analytics`,
    tenant: input.tenant,
    user: input.user,
    active: 'none',
    nav,
    ...(input.notices === undefined ? {} : { notices: input.notices }),
    body: `    <style>
      .an-grid { stroke: var(--line, #e6e3dc); stroke-width: 1; }
      .an-axis { fill: var(--muted, #7a756c); font-size: 10px; }
      .an-svg { width: 100%; height: auto; display: block; }
      .an-area { fill: var(--tint, rgba(70,110,90,.14)); stroke: none; }
      .an-line { fill: none; stroke: var(--accent-ink, #2f6b4f); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
      .an-line--people { stroke: var(--ink, #3b3833); stroke-width: 1.6; stroke-dasharray: 4 3; }
      .an-dot { fill: var(--accent-ink, #2f6b4f); }
      .an-dot--people { fill: var(--ink, #3b3833); }
      .an-legend { display: flex; align-items: center; gap: 8px; margin: 6px 0 14px; font-size: 12px; color: var(--muted, #7a756c); }
      .an-key { display: inline-block; width: 14px; height: 3px; border-radius: 2px; margin-left: 8px; background: var(--accent-ink, #2f6b4f); }
      .an-key--ppl { background: var(--ink, #3b3833); }
      .an-fig { margin: 0; }
      .an-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 0 0 18px; }
      .an-kpi { background: var(--card, #fff); border: 1px solid var(--line, #e6e3dc); border-radius: 12px; padding: 14px 16px; }
      .an-kpi__label { margin: 0 0 6px; font-size: 12px; letter-spacing: .02em; text-transform: uppercase; color: var(--muted, #7a756c); }
      .an-kpi__value { margin: 0; font-size: 27px; line-height: 1.1; font-variant-numeric: tabular-nums; }
      .an-kpi__hint { margin: 6px 0 0; font-size: 12px; color: var(--muted, #7a756c); }
      .an-2up { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin: 0 0 16px; align-items: start; }
      .an-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .an-table th, .an-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line, #e6e3dc); vertical-align: top; }
      .an-table thead th { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted, #7a756c); font-weight: 600; }
      .an-table tbody th { font-weight: 500; }
      .an-table--compact { margin-top: 10px; font-size: 12px; }
      .an-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .an-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
      .an-bar { display: block; width: 100%; max-width: 130px; height: 6px; border-radius: 3px; background: rgba(0,0,0,.07); overflow: hidden; }
      .an-bar__fill { display: block; height: 100%; background: var(--accent-ink, #2f6b4f); opacity: .55; }
      .an-pills { display: inline-flex; gap: 6px; }
      .an-pills a { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line, #e6e3dc); text-decoration: none; color: inherit; }
      .an-pills a[aria-current="page"] { background: var(--ink, #3b3833); color: #fff; border-color: transparent; }
      .an-empty { color: var(--muted, #7a756c); font-size: 13px; margin: 8px 0; }
      .an-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      .an-fine { font-size: 12px; color: var(--muted, #7a756c); }
      .an-steps { font-size: 13px; line-height: 1.7; }
      .an-kind { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line, #e6e3dc); color: var(--muted, #7a756c); }
    </style>
    <div class="pagehead">
      <div>
        <h1>Analytics</h1>
        <p>${num(totals.pageviews)} pageviews from ${plural(totals.visitors, 'person', 'people')} in the last ${String(report.days)} days
        <span class="an-fine">(${esc(shortDay(report.from))} – ${esc(shortDay(report.to))}, days in UTC)</span></p>
      </div>
      <div>${rangePills}</div>
    </div>

    <div class="an-kpis">
      ${kpi('Pageviews', num(totals.pageviews), 'One count per page load.')}
      ${kpi('People', num(totals.visitors), returningShare === null ? 'No returning people yet.' : `${pct(returningShare)} came back.`)}
      ${kpi('Sessions', num(totals.sessions), 'A visit ends after 30 idle minutes.')}
      ${kpi('Pages per session', totals.pagesPerSession === null ? '—' : totals.pagesPerSession.toFixed(2), 'How deep a visit goes.')}
      ${kpi('Time on page', duration(totals.secondsPerPage), 'Average, from the last event a page sent.')}
      ${kpi('Bounced', pct(totals.bounceRate), 'Sessions that saw one page only.')}
    </div>

    <div class="card"><h2>Traffic</h2>${trendChart(report)}</div>

    <div class="an-2up">
      <div class="card">
        <h2>Pages</h2>
        <p class="an-fine">Pageviews, and how many different people each page saw.</p>
        ${table(
          ['Page', 'Views', 'People'],
          report.topPages.map((p) => [pathCell(p.path), `<span class="an-num">${num(p.pageviews)}</span>${barCell(p.pageviews, maxPage)}`, num(p.visitors)]),
          'Top pages by pageviews',
          'No page has been viewed in this window.',
        )}
      </div>
      <div class="card">
        <h2>Links &amp; buttons</h2>
        <p class="an-fine">What people pressed, by its own words. A press is recorded before the next page loads.</p>
        ${table(
          ['Pressed', 'Where it goes', 'Presses'],
          report.clicks.map((c) => [
            `${esc(c.target === null || c.target === '' ? '(no label)' : c.target)}${c.targetKind === null ? '' : ` <span class="an-kind">${esc(c.targetKind)}</span>`}`,
            c.targetUrl === null ? '—' : `<span class="an-path">${esc(c.targetUrl)}</span>`,
            `<span class="an-num">${num(c.clicks)}</span>${barCell(c.clicks, maxClick)}`,
          ]),
          'Most pressed links and buttons',
          'No link has been pressed in this window. Links are recorded once the analytics script has run on a page; a link that navigates away is still recorded because the browser sends it on its way out.',
        )}
      </div>
    </div>

    <div class="an-2up">
      <div class="card">
        <h2>Where people came from</h2>
        <p class="an-fine">The site that referred them, or the campaign that sent them.</p>
        ${table(
          ['Source', 'Views'],
          report.sources.map((s) => [
            `${esc(s.source)}${s.medium === null ? '' : ` <span class="an-kind">${esc(s.medium)}</span>`}${barCell(s.pageviews, maxSource)}`,
            num(s.pageviews),
          ]),
          'Traffic sources',
          'No pageviews in this window.',
        )}
      </div>
      <div class="card">
        <h2>What they used</h2>
        <p class="an-fine">People, by device and browser.</p>
        ${table(
          ['Device', 'People', 'Views'],
          report.devices.map((d) => [esc(d.device), `${num(d.visitors)}${deviceTotal === 0 ? '' : ` <span class="an-fine">${pct(d.visitors / deviceTotal)}</span>`}`, num(d.pageviews)]),
          'Visitors by device',
          'No pageviews in this window.',
        )}
        ${report.browsers.length === 0 ? '' : `<p class="an-fine">Browsers: ${report.browsers.map((b) => `${esc(b.browser)} (${num(b.visitors)})`).join(', ')}.</p>`}
      </div>
    </div>

    <div class="an-2up">
      <div class="card">
        <h2>New and returning</h2>
        <p class="an-fine">People per day, split by whether this was their first visit.</p>
        ${table(
          ['Day', 'New', 'Returning'],
          // The last fortnight. A 90-day window is 90 rows of the same three numbers, which is a
          // wall, not a table — the trend above already carries the shape of the window.
          report.newReturning.slice(-14).map((d) => [esc(shortDay(d.day)), num(d.newVisitors), num(d.returningVisitors)]),
          'New and returning people per day',
          'No pageviews in this window.',
        )}
      </div>
      <div class="card">
        <h2>Do they come back?</h2>
        <p class="an-fine">Of the people whose first visit was in this window, the share who returned exactly N days later.</p>
        ${report.retention.every((r) => r.cohort === 0)
          ? `<p class="an-empty">Not enough history yet. A day-N number needs people whose first visit was N days ago, so a site that was instrumented today has nothing to show here for seven days.</p>`
          : table(
              ['Returned after', 'People', 'Of'],
              report.retention.map((r) => [
                esc(plural(r.offset, 'day')),
                `${num(r.visitors)} <span class="an-fine">${pct(r.rate)}</span>`,
                num(r.cohort),
              ]),
              'Return rate by day after the first visit',
              'Not enough history yet.',
            )}
      </div>
    </div>

    <div class="card">
      <h2>Latest events</h2>
      ${table(
        ['When', 'What', 'Page', 'Where'],
        report.recent.map((e) => [
          esc(e.ts.replace('T', ' ').replace('Z', '')),
          `<span class="an-kind">${esc(e.kind)}</span>`,
          `<span class="an-path">${esc(e.path)}</span>`,
          esc(e.target ?? '—'),
        ]),
        'The twelve most recent events',
        'Nothing recorded yet.',
      )}
      <p class="an-fine">Times are the server's, in UTC. The package keeps ${String(report.days)}-day windows here; its own retention setting decides how long rows survive.</p>
    </div>`,
  });
}
