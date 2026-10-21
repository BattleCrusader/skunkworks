/**
 * Print the current TOTP code for every enrolment file in a directory.
 *
 * Local convenience only: when you are testing on the box and do not want to reach for a
 * phone. It reads the one-time enrolment files and computes the code with the app's own
 * `totpCode`, so the code it prints is the code the login route verifies — not a
 * re-implementation that could drift.
 *
 * It carries no secret of its own, which is why it can live in the repository at all:
 * the secrets stay in `data/enrol-*.txt` (0600, gitignored).
 *
 *   node --no-warnings scripts/totp-now.ts [--dir data]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { totpCode } from '../app/admin/auth.ts';

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const dir = dirIndex === -1 ? 'data' : (args[dirIndex + 1] ?? 'data');

const files = readdirSync(dir).filter((f) => f.startsWith('enrol-') && f.endsWith('.txt')).sort();
if (files.length === 0) {
  console.error(`no enrolment files in ${dir}/ — run skwctl admin bootstrap --enrolment-out <path> first`);
  process.exit(1);
}

const now = Date.now();
const left = 30 - (Math.floor(now / 1000) % 30);
for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8');
  const email = /^email:\s+(.*)$/m.exec(text)?.[1]?.trim() ?? '(no email line)';
  const secret = /^secret:\s+(.*)$/m.exec(text)?.[1]?.replace(/\s+/g, '').trim();
  if (secret === undefined || secret === '') {
    console.log(`${file.padEnd(22)} ${email.padEnd(26)} (no secret: this file is a password reset)`);
    continue;
  }
  console.log(`${file.padEnd(22)} ${email.padEnd(26)} ${totpCode(secret, now)}  (${left}s left)`);
}
