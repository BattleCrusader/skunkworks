/**
 * Sign-in (Direction 03, screen one).
 *
 * The form is a plain HTML form: `POST /admin/login`, urlencoded, no JavaScript and no
 * CSRF field (login has no session to bind a token to — D28). Every field the route
 * already reads is present with the same name, and the autocomplete attributes are the
 * ones a password manager needs to fill the three steps in one go.
 *
 * Copy that states a consequence is copy that has to be true, so the numbers here come
 * from `app/admin/auth.ts`: a password is 16 characters (`PASSWORD_MIN_LENGTH`), and
 * five consecutive failures lock the account starting at one minute and doubling to
 * fifteen (`lockoutMsFor`). Nothing on this screen promises a capability the route does
 * not have — there is no "forgot password" link, because the reset token is minted by
 * the operator's own session, not by an anonymous form.
 */
import { layout } from './layout.ts';
import { esc } from './html.ts';

export interface SignInInput {
  tenant: { key: string; label: string };
  /** Where the operator is sent after a successful POST, for the browser's own hint. */
  next?: string;
}

export function signInScreen(input: SignInInput): string {
  const tenant = esc(input.tenant.key);
  const label = esc(input.tenant.label);
  return layout({
    title: `Sign in — ${input.tenant.key} — Skunkworks`,
    chrome: 'plain',
    body: `  <section class="signin" aria-labelledby="signin-title">
    <div class="signin__wrap">
      <p class="signin__brand"><span class="brand__mark" aria-hidden="true">S</span><b>Skunkworks</b><span class="tenantpill"><i aria-hidden="true"></i>${label}</span></p>
      <div class="signin__card">
        <h1 id="signin-title">Welcome back</h1>
        <p class="sub">Sign in to look after ${label}. This usually takes a few seconds.</p>
        <div class="stepdots" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i></div>
        <form method="post" action="/admin/login" enctype="application/x-www-form-urlencoded" data-tenant="${tenant}"${
          input.next === undefined ? '' : ` data-next="${esc(input.next)}"`
        }>
          <div class="sf">
            <label for="email">Your email</label>
            <input id="email" type="email" name="email" autocomplete="username" autocapitalize="none" spellcheck="false" required>
          </div>
          <div class="sf">
            <label for="password">Your password</label>
            <input id="password" type="password" name="password" autocomplete="current-password" required aria-describedby="password-help">
            <p class="help" id="password-help">At least 16 characters.</p>
          </div>
          <div class="sf">
            <label for="totp">6-digit code</label>
            <input id="totp" type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" aria-describedby="totp-help" placeholder="000000">
            <p class="help" id="totp-help">Open your authenticator app and type the code it shows. It changes every 30 seconds.</p>
          </div>
          <button class="submit" type="submit">Sign in</button>
        </form>
        <p class="signin__after">Five wrong tries in a row lock the account for a minute; more tries lock it for longer, up to 15 minutes.</p>
      </div>
      <p class="signin__foot">This page is only for the people who look after this site.<br>Need a hand? Ask your developer.</p>
    </div>
  </section>`,
  });
}
