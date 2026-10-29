/**
 * The portal's own stylesheet, served at `/portal.css`.
 *
 * ## Why a file and not a `<style>`
 *
 * The site's policy is `style-src 'self'` (`app/render/csp.ts`). An inline `<style>` in a portal
 * document is blocked by a browser while remaining visible to `curl` and to the tests — which is
 * exactly how the portal shipped unstyled (the same defect S8o fixed for CMS pages). A stylesheet
 * from this origin is allowed by the policy unchanged, needs no `'unsafe-inline'`, is cached by
 * the browser, and keeps the document free of scripting.
 *
 * ## Why `var(--token)` and no literals
 *
 * Every value that can follow the tenant comes from the theme's `:root` block (`/theme.css`):
 * `--paper`, `--ink`, `--muted`, `--accent`, `--warm`, `--rule`, `--gutter`, `--frame`, the three
 * families. The portal therefore changes palette, type and rhythm when the operator changes the
 * theme, and a tenant that has not uploaded one still gets a legible page from the fallbacks —
 * each `var()` carries the value the reference theme uses. Nothing here names a colour of its own
 * and nothing here loads from another host.
 *
 * ## Why element selectors are scoped
 *
 * `.portal-main` prefixes every rule that reaches a bare element. `/theme.css` is linked first,
 * so a selector like `.portal-main input` has to beat the theme's own `input` rules without
 * relying on which sheet was written last; scoping also keeps the portal's form rules from
 * restyling a marketing page if the two sheets are ever combined.
 */

/** Served byte-for-byte; the route adds the content type and cache headers. */
export const PORTAL_CSS = String.raw`/*
 * The portal — the site's account surface.
 *
 * Same paper, same rules, same type as the marketing pages; a narrower column because a form is
 * read line by line. Every value is a theme token with the reference theme's value as fallback.
 */

.portal {
  background: var(--paper, #f7f5f2);
  color: var(--ink, #0b1f33);
}

/* ── the page shell ─────────────────────────────────────────────────────────── */

.portal-main {
  max-width: var(--frame, 78rem);
  margin: 0 auto;
  padding: clamp(2rem, 4.5vw, 4rem) var(--gutter, 1.25rem) clamp(3rem, 8vw, 6rem);
}

.portal-container {
  max-width: 46rem;
  margin: 0 auto;
}

/* A form is read one field at a time, so it gets a narrower measure than prose. */
.portal-container--auth {
  max-width: 30rem;
}

/* A dashboard carries a five-column table; it needs the site's full frame. */
.portal-container--wide {
  max-width: 72rem;
}

/* ── type ───────────────────────────────────────────────────────────────────── */

.portal-intro {
  margin: 0 0 clamp(1.8rem, 3.5vw, 2.6rem);
}

.portal-eyebrow {
  margin: 0 0 0.8rem;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.68rem;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted, #55636f);
}

.portal-main h1 {
  margin: 0 0 0.55em;
  font-family: var(--serif, Georgia, serif);
  font-size: clamp(2rem, 1.35rem + 2.6vw, 3.25rem);
  font-weight: 600;
  line-height: 1.06;
  letter-spacing: -0.021em;
  color: var(--ink, #0b1f33);
  text-wrap: balance;
}

.portal-main h2 {
  margin: clamp(2rem, 4vw, 3rem) 0 0.9rem;
  font-family: var(--serif, Georgia, serif);
  font-size: clamp(1.35rem, 1.1rem + 0.9vw, 1.8rem);
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.015em;
  color: var(--ink, #0b1f33);
  text-wrap: balance;
}

.portal-main h3 {
  margin: 1.8rem 0 0.5rem;
  font-family: var(--sans, system-ui, sans-serif);
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--ink, #0b1f33);
}

.portal-lede {
  margin: 0;
  max-width: 56ch;
  color: var(--ink-2, #22364a);
  font-size: 1.05rem;
}

.portal-note,
.portal-main .note {
  max-width: 66ch;
  color: var(--muted, #55636f);
  font-size: 0.9rem;
}

/* The one place a verification URL is printed: a box with no mail transport. It has to look
   like an operator artefact rather than part of the product, so nobody reads it as the flow. */
.portal-note--dev {
  padding: 0.7rem 0.9rem;
  border: 1px dashed var(--rule-2, #cdc6bb);
  border-radius: 0.4rem;
  color: var(--ink-2, #22364a);
  word-break: break-all;
}

.portal-aside {
  max-width: none;
  margin: 1.2rem 0 0;
  color: var(--muted, #55636f);
  font-size: 0.9rem;
}

.portal-main a {
  color: var(--accent, #00468c);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.18em;
}

.portal-main a:hover {
  color: var(--ink, #0b1f33);
}

.portal-main small {
  font-size: 0.78em;
  color: var(--muted, #55636f);
}

.portal-main code {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.92em;
}

/* ── cards and panels ───────────────────────────────────────────────────────── */

.portal-card,
.portal-panel {
  background: var(--paper-2, #ffffff);
  border: 1px solid var(--rule-ink, rgba(11, 31, 51, 0.14));
}

.portal-card {
  padding: clamp(1.3rem, 2.6vw, 2rem);
}

.portal-panel {
  padding: clamp(1.2rem, 2.5vw, 1.8rem);
}

/* The form that is the whole card (sign in, register, enrol) owns the card's padding. */
.portal-form.portal-card {
  margin: 0;
}

/* ── forms ──────────────────────────────────────────────────────────────────── */

.portal-form {
  display: grid;
  gap: 1.15rem;
  margin: 0;
}

/* A form inside a dashboard is read line by line; the table around it may be wider. */
.portal-container--wide .portal-form {
  max-width: 46rem;
}

.portal-container--wide .portal-form.portal-card {
  width: 100%;
}

.portal-field {
  display: grid;
  gap: 0.4rem;
  min-width: 0;
}

.portal-field > label,
.portal-fieldset > legend {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.68rem;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted, #55636f);
}

.portal-fieldset {
  display: grid;
  gap: 0.65rem;
  margin: 0;
  padding: 0.95rem 1.05rem 1.1rem;
  border: 1px solid var(--rule, #d9d4cb);
  min-width: 0;
}

.portal-fieldset > legend {
  padding: 0 0.4rem;
}

.portal-main input:not([type='checkbox']):not([type='radio']),
.portal-main select,
.portal-main textarea {
  width: 100%;
  min-width: 0;
  padding: 0.7rem 0.75rem;
  font-family: var(--sans, system-ui, sans-serif);
  font-size: 1rem;
  line-height: 1.4;
  color: var(--ink, #0b1f33);
  background: var(--paper, #f7f5f2);
  border: 1px solid var(--rule, #d9d4cb);
  border-radius: 0;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.portal-main select {
  appearance: none;
  padding-right: 2.2rem;
  background-image: linear-gradient(45deg, transparent 50%, var(--muted, #55636f) 50%),
    linear-gradient(135deg, var(--muted, #55636f) 50%, transparent 50%);
  background-position: calc(100% - 1.15rem) 50%, calc(100% - 0.75rem) 50%;
  background-size: 0.4rem 0.4rem, 0.4rem 0.4rem;
  background-repeat: no-repeat;
}

.portal-main textarea {
  min-height: 8rem;
  resize: vertical;
  line-height: 1.55;
}

.portal-main input:not([type='checkbox']):not([type='radio']):hover,
.portal-main select:hover,
.portal-main textarea:hover {
  border-color: var(--rule-ink, rgba(11, 31, 51, 0.14));
}

.portal-main input:not([type='checkbox']):not([type='radio']):focus,
.portal-main select:focus,
.portal-main textarea:focus {
  outline: none;
  border-color: var(--accent, #00468c);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #00468c) 16%, transparent);
}

.portal-main input::placeholder,
.portal-main textarea::placeholder {
  color: var(--muted, #55636f);
}

/* A field the server has already refused: the border carries the same signal as the sentence. */
.portal-main input[aria-invalid='true'],
.portal-main select[aria-invalid='true'],
.portal-main textarea[aria-invalid='true'] {
  border-color: var(--warm, #b4400f);
}

.portal-check {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  font-family: var(--sans, system-ui, sans-serif);
  font-size: 0.95rem;
  line-height: 1.45;
  color: var(--ink-2, #22364a);
  cursor: pointer;
}

.portal-check input[type='checkbox'],
.portal-check input[type='radio'] {
  flex: 0 0 auto;
  width: 1.05rem;
  height: 1.05rem;
  margin: 0.18rem 0 0;
  accent-color: var(--accent, #00468c);
}

.portal-hint {
  margin: 0;
  color: var(--muted, #55636f);
  font-size: 0.82rem;
  line-height: 1.45;
}

.portal-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem;
  margin-top: 0.3rem;
}

/* ── buttons ────────────────────────────────────────────────────────────────── */

.portal-main button {
  font-family: var(--mono, ui-monospace, monospace);
  border-radius: 0;
  cursor: pointer;
}

/* The sign-out form is one quiet action at the end of the account page. */
.portal-signout {
  margin: 1.6rem 0 0;
}

/* Decision controls inside a table cell: two actions, one row, on a phone they wrap. */
.portal-decisions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
}

.portal-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  padding: 0.9rem 1.4rem;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.76rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--paper, #f7f5f2);
  background: var(--warm, #b4400f);
  border: 1px solid var(--warm, #b4400f);
  border-radius: 0;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}

.portal-button:hover {
  color: var(--paper, #f7f5f2);
  background: var(--ink, #0b1f33);
  border-color: var(--ink, #0b1f33);
}

.portal-button--quiet {
  color: var(--ink, #0b1f33);
  background: transparent;
  border-color: var(--rule-ink, rgba(11, 31, 51, 0.14));
}

.portal-button--quiet:hover {
  color: var(--paper, #f7f5f2);
  background: var(--ink, #0b1f33);
  border-color: var(--ink, #0b1f33);
}

.portal-button--danger {
  color: var(--warm, #b4400f);
  background: transparent;
  border-color: color-mix(in srgb, var(--warm, #b4400f) 45%, var(--rule, #d9d4cb));
}

.portal-button--danger:hover {
  color: var(--paper, #f7f5f2);
  background: var(--warm, #b4400f);
  border-color: var(--warm, #b4400f);
}

.portal-button--small {
  padding: 0.45rem 0.7rem;
  font-size: 0.64rem;
  letter-spacing: 0.1em;
}

/*
 * A link that is a button: the .portal-main a and .portal-main a:hover rules are more specific
 * than a class, so without these four rules "Sign in" would paint the accent colour on the warm
 * fill.
 */
.portal-main a.portal-button {
  color: var(--paper, #f7f5f2);
  text-decoration: none;
}

.portal-main a.portal-button:hover {
  color: var(--paper, #f7f5f2);
  background: var(--ink, #0b1f33);
  border-color: var(--ink, #0b1f33);
}

.portal-main a.portal-button--quiet {
  color: var(--ink, #0b1f33);
}

.portal-main a.portal-button--quiet:hover {
  color: var(--paper, #f7f5f2);
}

/* ── banners: a refusal, a confirmation, a note the page must not hide ─────── */

.portal-banner {
  max-width: none;
  margin: 0 0 1.2rem;
  padding: 0.85rem 1rem;
  border-left: 3px solid var(--accent, #00468c);
  background: var(--wash, #eef1f5);
  color: var(--ink-2, #22364a);
  font-size: 0.95rem;
  line-height: 1.5;
}

.portal-banner > :last-child {
  margin-bottom: 0;
}

.portal-banner--error {
  border-left-color: var(--warm, #b4400f);
  background: color-mix(in srgb, var(--warm, #b4400f) 8%, var(--paper, #f7f5f2));
  color: var(--ink, #0b1f33);
}

.portal-banner--success {
  border-left-color: var(--accent, #00468c);
  background: color-mix(in srgb, var(--accent, #00468c) 7%, var(--paper, #f7f5f2));
}

.portal-error {
  margin: 0;
  color: var(--warm, #b4400f);
  font-size: 0.88rem;
  line-height: 1.45;
}

/* ── tables of applications ────────────────────────────────────────────────── */

.portal-table-scroll {
  overflow-x: auto;
  background: var(--paper-2, #ffffff);
  border: 1px solid var(--rule-ink, rgba(11, 31, 51, 0.14));
}

.portal-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.95rem;
}

.portal-table th {
  padding: 0.8rem 0.9rem;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.64rem;
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  text-align: left;
  white-space: nowrap;
  color: var(--muted, #55636f);
  background: var(--paper, #f7f5f2);
  border-bottom: 1px solid var(--rule, #d9d4cb);
}

.portal-table td {
  padding: 0.9rem;
  vertical-align: top;
  color: var(--ink-2, #22364a);
  border-bottom: 1px solid var(--rule-2, #e6e1d8);
}

.portal-table tbody tr:last-child td {
  border-bottom: 0;
}

.portal-table strong {
  color: var(--ink, #0b1f33);
}

.portal-table .summary {
  max-width: 46ch;
  color: var(--ink-2, #22364a);
}

.portal-table .basis {
  margin-top: 0.35rem;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  color: var(--muted, #55636f);
}

.portal-table .state,
.portal-state {
  margin-top: 0.35rem;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.66rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent, #00468c);
}

/* In the applicant's table the state is a span in its own cell; in the advertiser's it is a
 * block under the date. Only the span needs a box of its own. */
.portal-state {
  display: inline-block;
}

.portal-table td > .portal-button {
  margin: 0.15rem 0.3rem 0.15rem 0;
}

.portal-empty {
  max-width: none;
  margin: 0;
  padding: clamp(1.6rem, 4vw, 2.6rem) 1.25rem;
  background: var(--paper-2, #ffffff);
  border: 1px dashed var(--rule-ink, rgba(11, 31, 51, 0.14));
  color: var(--muted, #55636f);
  text-align: center;
}

/* ── the applicant's summary, a definition list ────────────────────────────── */

.portal-profile {
  display: grid;
  grid-template-columns: minmax(8rem, 13rem) 1fr;
  gap: 0.7rem 1.6rem;
  margin: 0;
  padding: clamp(1.2rem, 2.5vw, 1.8rem);
  background: var(--paper-2, #ffffff);
  border: 1px solid var(--rule-ink, rgba(11, 31, 51, 0.14));
}

.portal-profile dt {
  padding-top: 0.12rem;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.66rem;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted, #55636f);
}

.portal-profile dd {
  margin: 0;
  color: var(--ink-2, #22364a);
  overflow-wrap: anywhere;
}

.portal-profile ul {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.9rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* ── the authenticator key, shown exactly once ──────────────────────────────── */

.portal-totp {
  margin: 0;
  padding: 1rem;
  text-align: center;
  overflow-wrap: anywhere;
  background: var(--wash, #eef1f5);
  border: 1px solid var(--rule, #d9d4cb);
}

.portal-totp code {
  font-size: clamp(1.05rem, 3vw, 1.4rem);
  letter-spacing: 0.16em;
}

/* ── a small label on a role or a state ─────────────────────────────────────── */

.portal-role {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.64rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent, #00468c);
  background: color-mix(in srgb, var(--accent, #00468c) 6%, var(--paper, #f7f5f2));
  border: 1px solid color-mix(in srgb, var(--accent, #00468c) 32%, var(--rule, #d9d4cb));
}

/* A list of destinations on the account page: links, not prose. */
.portal-links {
  display: grid;
  gap: 0.55rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.portal-links a {
  font-weight: 500;
}

/* ── phone width: one column, and a table that becomes a list of records ───── */

@media (max-width: 640px) {
  .portal-main {
    padding: 1.5rem 1rem 3.5rem;
  }

  .portal-container,
  .portal-container--auth,
  .portal-container--wide {
    max-width: none;
  }

  .portal-profile {
    grid-template-columns: 1fr;
    gap: 0.15rem;
  }

  .portal-profile dd {
    margin: 0 0 0.85rem;
  }

  .portal-profile dd:last-child {
    margin-bottom: 0;
  }

  .portal-table-scroll {
    overflow: visible;
    background: transparent;
    border: 0;
  }

  .portal-table,
  .portal-table tbody,
  .portal-table tr,
  .portal-table td {
    display: block;
    width: 100%;
  }

  /* The header row is the data-label on each cell now; it is not a visual row. */
  .portal-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .portal-table tr {
    margin: 0 0 0.9rem;
    padding: 0.55rem 0.9rem;
    background: var(--paper-2, #ffffff);
    border: 1px solid var(--rule-ink, rgba(11, 31, 51, 0.14));
  }

  .portal-table td {
    padding: 0.45rem 0;
    border: 0;
  }

  .portal-table td[data-label]::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 0.15rem;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 0.62rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted, #55636f);
  }

  .portal-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .portal-actions .portal-button {
    width: 100%;
  }
}
`;
