/**
 * What a message says — the templates, in one place, with the escaping done for the caller.
 *
 * Every template is plain text. Not for simplicity: an HTML email that renders a stranger's
 * `display_name` is an injection surface in a client we do not control, and the board has nothing to
 * say that a paragraph cannot. The one link a mail carries is a path on this site, so the host is
 * the tenant's and the mailer never has to know it.
 *
 * `vars` come from the database (`cms_mail.vars_json`), which means they come from a person's
 * keyboard. They are interpolated into text, never into markup, and a value that is not a string
 * renders as nothing rather than as `[object Object]`.
 */

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
}

type Vars = Record<string, unknown>;

function str(vars: Vars, key: string): string {
  const value = vars[key];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** The templates this build can send. A name outside the set is refused, not silently blank. */
export const TEMPLATES = ['verify_email', 'account_exists', 'job_match'] as const;
export type Template = (typeof TEMPLATES)[number];

export function isTemplate(name: string): name is Template {
  return (TEMPLATES as readonly string[]).includes(name);
}

export function renderMail(template: string, vars: Vars): RenderedMail {
  switch (template) {
    case 'verify_email': {
      const path = str(vars, 'verify_path');
      const hours = str(vars, 'ttl_hours') || '24';
      return {
        subject: 'Confirm your email to finish signing up',
        text: [
          'Someone — hopefully you — started signing up with this address.',
          '',
          `Open this link within ${hours} hours to confirm it:`,
          path,
          '',
          'If this was not you, ignore this message: the account stays inactive and is deleted with',
          'the rest of the unfinished sign-ups.',
        ].join('\n'),
      };
    }
    case 'account_exists':
      return {
        subject: 'You already have a Fractional Works account',
        text: [
          'Someone tried to create an account with this address, and one already exists.',
          '',
          'If that was you, sign in instead — and use “forgot password” if you cannot remember it.',
          'If it was not you, nothing has changed and you can ignore this message.',
        ].join('\n'),
      };
    case 'job_match': {
      const title = str(vars, 'job_title');
      const company = str(vars, 'company');
      const path = str(vars, 'job_path');
      return {
        subject: `New fractional role: ${title}${company === '' ? '' : ` at ${company}`}`,
        text: [
          `A role matching your profile was just posted: ${title}${company === '' ? '' : ` at ${company}`}.`,
          '',
          path,
          '',
          'You are receiving this because your profile is discoverable and you asked to hear about',
          'new roles. Change that in your profile settings at any time.',
        ].join('\n'),
      };
    }
    default: {
      // A plugin's template. The host does not invent copy for a plugin: the plugin supplies the
      // words in `vars`, and this branch is the only place they can come from. A name with no words
      // is refused rather than queued as a blank message.
      const subject = str(vars, 'subject');
      const text = str(vars, 'text');
      if (subject === '' || text === '') {
        throw new Error(`template ${JSON.stringify(template)} is not a core template and carries no vars.subject/vars.text`);
      }
      return { subject: subject.slice(0, 200), text: text.slice(0, 20_000) };
    }
  }
}
