/**
 * The account screen — what an operator can do about *themselves*.
 *
 * Until this screen existed the answer was "nothing": the app bar drew an avatar and an
 * email as inert text, `POST /admin/t/<key>/logout` had no control anywhere that reached
 * it, and the only password path was E-19's reset token — minted by a signed-in session
 * and delivered by mail, which this build cannot send. An operator who wanted out had to
 * clear cookies by hand.
 *
 * Three forms, all plain HTML, all `POST` (they change state, so no link and no `GET`):
 * email, password, logout. Every one carries the session-bound CSRF token in its `csrf`
 * field — the same mechanism the tables screen's generated forms use, and the only one
 * D28 leaves available to a form that has no script.
 *
 * The screen reports outcomes by PRG (`?changed=1`, `?e=current`, …) rather than by
 * rendering the result of a POST: a refresh after a password change must not repost it.
 */
import { ICON, layout } from './layout.ts';
import { esc } from './html.ts';

export interface AccountInput {
  tenant: { key: string; label: string };
  user: { email: string; role: string };
  /** The session's CSRF token, in the `csrf` field of all three forms. */
  csrf: string;
  /** `changed` | `email` | `current` | `short` | `same` | undefined. */
  flash?: string | undefined;
  notices?: number;
  /** From `PASSWORD_MIN_LENGTH` — the help text and the server's rule are one number. */
  minPasswordLength: number;
}

/** The one line each flash is allowed to say. Unknown values say nothing. */
const FLASH: Record<string, { kind: 'ok' | 'bad'; text: string }> = {
  changed: { kind: 'ok', text: 'Your password is changed. Every other device signed in as you has been signed out.' },
  email: { kind: 'ok', text: 'Your email address is changed. Use the new one next time you sign in.' },
  current: { kind: 'bad', text: 'That is not the password on this account, so nothing was changed.' },
  short: { kind: 'bad', text: 'The new password is too short, so nothing was changed.' },
  same: { kind: 'bad', text: 'The new password is the same as the current one, so nothing was changed.' },
  format: { kind: 'bad', text: 'That does not look like an email address, so nothing was changed.' },
  taken: { kind: 'bad', text: 'Another account here already uses that address, so nothing was changed.' },
};

const roleLabel = (role: string): string =>
  role === 'owner' ? 'Owner' : role === 'editor' ? 'Editor' : role === 'viewer' ? 'Viewer' : 'Fleet operator';

function flashOf(flash: string | undefined): string {
  if (flash === undefined) return '';
  const entry = FLASH[flash];
  if (entry === undefined) return '';
  const icon = entry.kind === 'ok' ? ICON.check : ICON.warn;
  return `    <div class="acct__flash acct__flash--${entry.kind}" role="status">${icon}<span>${esc(entry.text)}</span></div>\n`;
}

export function accountScreen(input: AccountInput): string {
  const base = `/admin/t/${encodeURIComponent(input.tenant.key)}`;
  const email = esc(input.user.email);
  const csrf = esc(input.csrf);

  return layout({
    title: `Your account — ${input.tenant.key} — Skunkworks`,
    tenant: input.tenant,
    user: input.user,
    active: 'none',
    ...(input.notices === undefined ? {} : { notices: input.notices }),
    body: `    <div class="pagehead">
      <div>
        <h1>Your account</h1>
        <p>You are signed in as <b>${email}</b> (${esc(roleLabel(input.user.role))}) on ${esc(input.tenant.label)}.</p>
      </div>
      <div class="actions">
        <a class="btn" href="${esc(`${base}/`)}">${ICON.chevron} Back to your pages</a>
      </div>
    </div>

${flashOf(input.flash)}
    <div class="acct">
      <section class="card acct__card" aria-labelledby="acct-email">
        <h2 id="acct-email">Your email</h2>
        <p class="acct__lede">This is the address you sign in with. Changing it does not change your password.</p>
        <form method="post" action="${esc(`${base}/account/email`)}" enctype="application/x-www-form-urlencoded">
          <input type="hidden" name="csrf" value="${csrf}">
          <div class="sf">
            <label for="account-email">Email address</label>
            <input id="account-email" type="email" name="email" value="${email}" autocomplete="username" autocapitalize="none" spellcheck="false" required>
          </div>
          <button class="btn btn--primary" type="submit">Save email</button>
        </form>
      </section>

      <section class="card acct__card" aria-labelledby="acct-password">
        <h2 id="acct-password">Your password</h2>
        <p class="acct__lede">Changing it signs you out everywhere else. You stay signed in here.</p>
        <form method="post" action="${esc(`${base}/account/password`)}" enctype="application/x-www-form-urlencoded">
          <input type="hidden" name="csrf" value="${csrf}">
          <div class="sf">
            <label for="current_password">Your current password</label>
            <input id="current_password" type="password" name="current_password" autocomplete="current-password" required aria-describedby="current-help">
            <p class="help" id="current-help">So that a borrowed browser cannot change it.</p>
          </div>
          <div class="sf">
            <label for="new_password">A new password</label>
            <input id="new_password" type="password" name="new_password" autocomplete="new-password" required minlength="${input.minPasswordLength}" aria-describedby="new-help">
            <p class="help" id="new-help">At least ${input.minPasswordLength} characters. A sentence you will remember beats a short jumble.</p>
          </div>
          <button class="btn btn--primary" type="submit">Change password</button>
        </form>
      </section>

      <section class="card acct__card acct__card--wide" aria-labelledby="acct-signout">
        <h2 id="acct-signout">Signing out</h2>
        <p class="acct__lede">Signing out ends this session on the server, not just in this browser.</p>
        <form method="post" action="${esc(`${base}/logout`)}" enctype="application/x-www-form-urlencoded">
          <input type="hidden" name="csrf" value="${csrf}">
          <button class="btn btn--danger" type="submit">Sign out</button>
        </form>
      </section>
    </div>

    <div class="helper">
      ${ICON.info}
      <span><b>Locked out?</b> A wrong password five times in a row locks the account for a minute, doubling up to fifteen. Your developer can issue a reset token from the server.</span>
    </div>
`,
  });
}
