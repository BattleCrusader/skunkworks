/**
 * Australian personal information — **the four shapes this product refuses to hold**.
 *
 * The Privacy Act 1988 (Cth) defines personal information in s 6(1) as "information or an opinion
 * about an identified individual, or an individual who is reasonably identifiable", whether true
 * or not, and whether recorded in a material form or not. The OAIC's guidance says that where it is
 * unclear whether information is personal information, an organisation should err on the side of
 * treating it as personal information. Under that rule a job board's most dangerous columns are
 * not the ones with obvious names — `cms_account.email` is understood — but the four free-text
 * ones: a summary, a cover note, a display name and a `location`, each of which is a place a person
 * will type a phone number, a street address, a diagnosis or a religion because that is what
 * people do with a text box, and each of which is then shown to a stranger.
 *
 * So the rules are here, in one file, as pure functions over strings: no database, no route, no
 * clock, no I/O. A caller cannot enforce a rule it cannot see, and a rule implemented in a handler
 * is a rule that the next handler will not know about. `docs/privacy/pii-australia.md` is the
 * position this file implements; where the two disagree, this file is wrong and says so in a test.
 *
 * ## What each function is *for*
 *
 *   - `screenFreeText` is the **gate**. It refuses the four things that must never be stored in a
 *     free-text field: an email address, an Australian phone number, a street address, and any
 *     disclosure from the sensitive classes in s 6 (or a government identifier, or a date of
 *     birth). It is used before a write and before a render, so a refused value is never in the
 *     table and never on a page.
 *   - `normaliseSuburbCity` is the **bound** on `cms_profile.location`. The column is a locality,
 *     not an address: APP 3's proportionality rule (OAIC APP 3 guideline 3.26: information
 *     collected should be relevant, minimal and not excessive) is what makes "suburb, or city" the
 *     right granularity for a job board and a street address the wrong one. It returns a value
 *     that cannot be an address — no house number anywhere, no street-type word after the first
 *     token — or it says which of the three ways the input failed.
 *   - `redactFreeText` is the **operator's view**. An operator reading a message to answer it needs
 *     the sentence; they do not need the phone number inside it. Redaction keeps the prose and
 *     removes the contact detail, so the text can be stored, exported or screenshot into a support
 *     ticket without the detail travelling with it.
 *   - `AU_STATES` is the closed vocabulary the third function validates against. One list, exported,
 *     because a second copy of the eight abbreviations is a second answer to "is NSW a state".
 *
 * ## The false-positive rule, which is the hard part
 *
 * A screening function that refuses ordinary professional writing is worse than none: it fails the
 * person who wrote "health-tech product manager" or "disability support worker", and it teaches
 * operators to bypass the gate. So the matchers are **structural**, not topical:
 *
 *   - a phone number must have a real Australian number's digit pattern (10 digits, a mobile
 *     prefix or an area code) — not merely be a run of digits;
 *   - an address must have a **number adjacent to a street-type word**. "3 ways to ship faster" and
 *     "I finished 2nd place" contain neither a number followed by a street type nor an ordinal,
 *     because the number token here accepts exactly one trailing letter, so "1st"/"2nd"/"3rd"
 *     cannot match;
 *   - sensitive categories need a **first-person disclosure shape** — "my health condition",
 *     "I was diagnosed with", "I'm a Christian", "my political views", "convicted of". The bare
 *     domain words (healthcare, mental health services, disability support, indigenous engagement,
 *     criminal justice reform) are ordinary vocabulary on a job board and are deliberately allowed;
 *   - a business number (1300/1800/13) is not personal information, so it is not refused. A support
 *     line in a cover note is a fact about a company, not about a person.
 *
 * The consequence is stated plainly rather than hidden: this module is a net with a known mesh
 * size. It catches the shapes people actually type. It cannot catch a street address written as
 * prose ("the place on the corner of Smith and George"), and it does not try — the residual risk is
 * named in `docs/privacy/pii-australia.md` §7, and the control that covers it is that free text is
 * never shown to an advertiser with contact detail intact *and* that an operator can redact.
 *
 * Every function here takes a `string` and returns a value. A non-string is a programming error in
 * the caller's type, not a category of personal information: it fails loudly rather than being
 * silently classified as one of the four reasons, because a refusal that says "address" about an
 * `undefined` would be a lie in the operator's log.
 */

/** The eight state and territory abbreviations Australia Post's addressing standard uses. */
export const AU_STATES = Object.freeze(['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] as const);

/** One of the eight, as a type — so a caller cannot spell a ninth. */
export type AuState = (typeof AU_STATES)[number];

/**
 * Full names, mapped to the abbreviation, because people type "New South Wales" and a location
 * column holding the long form beside a form holding the short one is two answers to one question.
 * Internal: `AU_STATES` is the list the product validates against, and this is derived from it.
 */
const STATE_NAMES: ReadonlyMap<string, AuState> = new Map([
  ['australian capital territory', 'ACT'],
  ['new south wales', 'NSW'],
  ['northern territory', 'NT'],
  ['queensland', 'QLD'],
  ['south australia', 'SA'],
  ['tasmania', 'TAS'],
  ['victoria', 'VIC'],
  ['western australia', 'WA'],
]);

/**
 * The street-type vocabulary, and **the single copy of it**.
 *
 * `screenFreeText` builds its address pattern from this array and `normaliseSuburbCity` looks tokens
 * up in the set built from it, so the two cannot disagree about whether "pde" is a street. The order
 * matters: longer forms precede their abbreviations ("street" before "st", "avenue" before "ave"),
 * because an alternation takes the first branch that matches and "St" must not shadow "Street".
 */
const STREET_TYPES = [
  'street',
  'st',
  'road',
  'rd',
  'avenue',
  'ave',
  'drive',
  'dr',
  'lane',
  'ln',
  'court',
  'ct',
  'place',
  'pl',
  'way',
  'close',
  'crescent',
  'terrace',
  'highway',
  'hwy',
  'parade',
  'pde',
] as const;

const STREET_TYPE_SET: ReadonlySet<string> = new Set(STREET_TYPES);

/** Longest locality we will store: "Surry Hills NSW 2010" is 20 characters. */
const LOCALITY_MAX = 80;
/** A locality is a name: one to four tokens ("Tweed Heads South", "Port Macquarie"). */
const LOCALITY_TOKENS_MAX = 4;
/** Australia Post allocates 0200–9999; a four-digit token outside that is not a postcode. */
const POSTCODE_MIN = 200;
const POSTCODE_MAX = 9_999;

/** The refused categories. The union is closed: a caller can switch on it exhaustively. */
export type ScreenReason = 'email' | 'phone' | 'address' | 'sensitive';

export interface ScreenOk {
  readonly ok: true;
  /** Unchanged, byte for byte: a screen that rewrites text is a screen that edits a person's words. */
  readonly value: string;
}

export interface ScreenRefused {
  readonly ok: false;
  readonly reason: ScreenReason;
}

export type ScreenResult = ScreenOk | ScreenRefused;

/** The three ways a locality can fail to be a locality. */
export type LocalityReason = 'street' | 'too-long' | 'digits';

export interface LocalityOk {
  readonly ok: true;
  /** Canonical: one space between tokens, state uppercased, postcode kept. `''` means "not given". */
  readonly value: string;
}

export interface LocalityRefused {
  readonly ok: false;
  readonly reason: LocalityReason;
}

export type LocalityResult = LocalityOk | LocalityRefused;

// --- the patterns ---------------------------------------------------------------------------
//
// Every quantifier below is bounded. `screenFreeText` is called on text a stranger typed, at a
// length the form caps but this module does not, and an unbounded nested quantifier over 10 000
// characters is how a privacy control becomes a denial of service. The caps are the longest real
// value plus slack: a local part is 64 octets by RFC 5321, a DNS label 63, an Australian house
// number 5 digits, a postcode 4.

/** A plain address. Deliberately does not accept a bare domain ("example.com") — that is a link. */
const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,7}\.[A-Za-z]{2,24}\b/;

/**
 * The same address with "at"/"dot" spelled out or bracketed — "jane (at) example (dot) com".
 *
 * The TLD is a closed list, and that is what keeps this from firing on prose: "look at the dot
 * product" ends in a word no registry issues. A pattern that accepted any word after "dot" would
 * refuse ordinary technical writing, and the person who wrote it would have no idea why.
 */
const EMAIL_OBFUSCATED =
  /\b[A-Za-z0-9._%+-]{1,64}\s*(?:\(\s*at\s*\)|\[\s*at\s*\]|\bat\b)\s*[A-Za-z0-9-]{1,63}\s*(?:\(\s*dot\s*\)|\[\s*dot\s*\]|\bdot\b)\s*(?:com|net|org|edu|gov|info|biz|dev|app|io|ai|co|me|au|nz|uk|us)(?:\.[a-z]{2})?\b/i;

/** 04xx xxx xxx — a mobile, with or without separators, and only 10 digits in total. */
const PHONE_MOBILE = /\b04\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/;

/** +61 4xx xxx xxx. The leading `+` is the anchor; a `\b` before it can never match. */
const PHONE_MOBILE_INTL = /\+61[\s.-]?4\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/;

/** (0x) xxxx xxxx — a landline with an area code. 13/1300/1800 are business numbers and absent.
 * The lookbehind, not `\b`, so the opening bracket of `(02) 9123 4567` is part of the match and a
 * redaction does not leave a stray `(` behind. `(?<![\w])` still refuses to start mid-number. */
const PHONE_LANDLINE = /(?<![\w])\(?0[2378]\)?[\s.-]?\d{4}[\s.-]?\d{4}\b/;

/** +61 x xxxx xxxx. */
const PHONE_LANDLINE_INTL = /\+61[\s.-]?[2378][\s.-]?\d{4}[\s.-]?\d{4}\b/;

/** A postal address that is not a street: "PO Box 55", "GPO Box 1234". */
const PO_BOX = /\bG?P\.?\s?O\.?\s*Box\b/i;

/**
 * A street address: a house number, then up to three words, then a street-type word.
 *
 * `[a-z]?` allows exactly one trailing letter ("12A Smith St") and that is also what makes an
 * ordinal impossible to match: "1st", "2nd" and "3rd" carry two letters, so "I finished 2nd place"
 * is not an address. The number must be separated from the name by whitespace, so "12Smith St"
 * (which nobody writes) is not matched in preference to being wrong about "12 Smith St".
 */
const ADDRESS = new RegExp(
  String.raw`\b\d{1,5}[a-z]?(?:\s*[/-]\s*\d{1,5})?\s+(?:[A-Za-z][A-Za-z'’.-]{0,30}\s+){0,3}(?:${STREET_TYPES.join('|')})\b\.?`,
  'i',
);

/**
 * Sensitive-category disclosures and the identifiers APP 3 never makes necessary here.
 *
 * Grouped by the s 6 category each one names. Every pattern requires a disclosure shape, not a
 * topic: "health" is not matched, "my health condition" is. `criminal record` is excluded when it
 * is `criminal record check` — a police check is a hiring requirement, not a criminal record, and
 * the phrase appears in half the ads on a job board this size.
 */
const SENSITIVE: readonly RegExp[] = [
  // health
  /\b(?:i|we)\s+(?:have|had|has|am|was|'m|'ve)\s+(?:been\s+)?(?:diagnosed|diagnosis)\b/i,
  /\bdiagnosed\s+with\b/i,
  /\bmy\s+(?:health|medical|mental\s+health|physical)\s+(?:condition|conditions|issues?|problems?|history|status)\b/i,
  /\b(?:chronic|terminal|serious|long[- ]term)\s+(?:health\s+|medical\s+|mental\s+health\s+)?(?:illness|disease|condition)\b/i,
  /\b(?:i\s+(?:have|had|'ve\s+had)|my)\s+(?:a\s+)?(?:disability|disabled)\b/i,
  /\b(?:i\s+am|i'm)\s+(?:on\s+)?(?:sick|medical|stress|carer'?s)\s+leave\b/i,
  /\bmy\s+(?:anxiety|depression|adhd|autism|asthma|diabetes|epilepsy|arthritis)\b/i,
  // religion
  /\b(?:i\s+am|i'm|we\s+are|we're)\s+(?:a\s+|an\s+)?(?:christian|catholic|protestant|muslim|jewish|hindu|buddhist|sikh|atheist|agnostic|mormon|jehovah'?s\s+witness)\b/i,
  /\bmy\s+(?:religion|faith|religious\s+(?:beliefs?|views?|convictions?))\b/i,
  /\b(?:practi[cs]e|practising|practicing)\s+(?:christianity|islam|judaism|hinduism|buddhism|sikhism)\b/i,
  // sexuality and gender identity
  /\b(?:i\s+am|i'm)\s+(?:a\s+)?(?:gay|lesbian|bisexual|queer|transgender|non[- ]binary|heterosexual)\b/i,
  /\bmy\s+(?:sexual\s+orientation|sexuality|gender\s+identity)\b/i,
  /\bsame[- ]sex\s+(?:partner|relationship|marriage)\b/i,
  // political opinion
  /\bmy\s+political\s+(?:views?|opinions?|beliefs?|affiliation|leanings?)\b/i,
  /\bpolitical\s+(?:party\s+)?membership\b/i,
  /\bmember\s+of\s+(?:the\s+)?(?:australian\s+labor|labor|liberal|nationals|greens|one\s+nation|united\s+australia)\s+party\b/i,
  /\bi\s+(?:vote|voted|support|back)\s+(?:for\s+)?(?:labor|liberal|the\s+greens|nationals|one\s+nation)\b/i,
  // criminal record
  /\bcriminal\s+(?:record|history|convictions?)\b(?!\s*(?:check|checks|screening|clearance))/i,
  /\bconvicted\s+of\b/i,
  /\bspent\s+convictions?\b/i,
  /\bserved\s+(?:time|a\s+sentence)\s+in\s+(?:prison|jail|gaol)\b/i,
  // government identifiers and date of birth — personal information APP 3 does not make necessary
  /\bdate\s+of\s+birth\b/i,
  /\bD\.O\.B\.?\b/i,
  /\btax\s+file\s+number\b|\bTFN\b/i,
  /\bmedicare\s+(?:number|card|no\.?)\b/i,
  /\bpassport\s+(?:number|no\.?)\b/i,
  /\b(?:driver'?s?\s+)?licen[cs]e\s+(?:number|no\.?)\b/i,
];

/** A fresh global copy per call: a shared `/g` regex carries `lastIndex` between calls. */
function globalOf(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

/**
 * Refuse the four shapes that must never enter a free-text field.
 *
 * Returns the value **unchanged** when it passes: screening is a decision about a string, not an
 * edit to it. The reason is a category for the refusal message and the operator's log — one fixed
 * precedence (email, then phone, then address, then sensitive) so the same input always answers the
 * same thing, which is what makes it testable. It is not a diagnosis: a note with an email *and* an
 * address reports `email`, and the writer fixes one thing at a time.
 */
export function screenFreeText(input: string): ScreenResult {
  if (input === '') return { ok: true, value: input };

  if (EMAIL.test(input) || EMAIL_OBFUSCATED.test(input)) return { ok: false, reason: 'email' };
  if (PHONE_MOBILE.test(input) || PHONE_MOBILE_INTL.test(input)) return { ok: false, reason: 'phone' };
  if (PHONE_LANDLINE.test(input) || PHONE_LANDLINE_INTL.test(input)) return { ok: false, reason: 'phone' };
  if (ADDRESS.test(input) || PO_BOX.test(input)) return { ok: false, reason: 'address' };
  for (const pattern of SENSITIVE) if (pattern.test(input)) return { ok: false, reason: 'sensitive' };

  return { ok: true, value: input };
}

/**
 * Constrain a location to suburb or city — the most this product stores, by decision.
 *
 * Accepted: `Newcastle`, `Newcastle NSW`, `Melbourne, VIC`, `Surry Hills NSW 2010`. The comma is
 * punctuation a person types, not data, so it is dropped; the state is uppercased because it is a
 * closed vocabulary; the postcode is kept only when it is the last token and four digits.
 *
 * The locality's own casing is **not** normalised, deliberately. "McKinnon", "O'Halloran Hill" and
 * "St Kilda" are all correct and every title-caser gets at least one of them wrong, while the
 * column is display text and not a join key. Uppercasing the state is the one casing decision that
 * is safe, because the state is not a name.
 *
 * Refusals, and why each is one of three:
 *
 *   - `street` — a street-type word appears anywhere after the first token, or the string is a
 *     postal address ("PO Box 55"). Position 0 is exempt because "St Kilda", "St Peters" and
 *     "Lane Cove" are Australian suburbs whose names begin with a street-type word. A locality
 *     does not *end* in "Street"; an address does, and an address also ends in "St", "Rd", "Pde".
 *   - `digits` — any digit outside a trailing four-digit postcode. This is the house number rule:
 *     "12 Sydney" and "Unit 4/12" both fail here, and so does "Sydney NSW 200" (three digits) and
 *     "Sydney NSW 2010 extra" (the postcode is no longer last).
 *   - `too-long` — over 80 characters, which no locality needs and which is how a textarea gets
 *     pasted into a one-line field.
 *
 * It does not check that "Sydney" is a real suburb: that needs a gazetteer, and a gazetteer that
 * rejects "Wyndham Vale" because the dataset predates the estate is a worse control than none.
 * What it guarantees is the thing that matters here — no house number and no street type, so the
 * column cannot hold an address.
 */
export function normaliseSuburbCity(input: string): LocalityResult {
  const raw = input.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (raw === '') return { ok: true, value: '' };
  if (raw.length > LOCALITY_MAX) return { ok: false, reason: 'too-long' };
  if (PO_BOX.test(raw)) return { ok: false, reason: 'street' };

  const tokens = raw.split(' ');

  // A street-type word is a street marker unless it is the first token: see the doc comment.
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (STREET_TYPE_SET.has(token.replace(/\.$/, '').toLowerCase())) return { ok: false, reason: 'street' };
  }

  // The postcode is the only place a digit may appear, and only as the final token.
  let postcode: string | null = null;
  const last = tokens[tokens.length - 1] ?? '';
  if (/^\d{4}$/.test(last)) {
    const asNumber = Number(last);
    if (asNumber < POSTCODE_MIN || asNumber > POSTCODE_MAX) return { ok: false, reason: 'digits' };
    postcode = last;
    tokens.pop();
  }
  if (tokens.some((token) => /\d/.test(token))) return { ok: false, reason: 'digits' };

  // The state, as an abbreviation or a full name, and only as the final token.
  let state: AuState | null = null;
  for (const width of [3, 2] as const) {
    if (tokens.length < width) continue;
    const named = STATE_NAMES.get(tokens.slice(-width).join(' ').toLowerCase());
    if (named === undefined) continue;
    state = named;
    for (let i = 0; i < width; i += 1) tokens.pop();
    break;
  }
  if (state === null) {
    const lastWord = tokens[tokens.length - 1] ?? '';
    const named = STATE_NAMES.get(lastWord.toLowerCase());
    if (named !== undefined) {
      state = named;
      tokens.pop();
    } else if ((AU_STATES as readonly string[]).includes(lastWord.toUpperCase())) {
      state = lastWord.toUpperCase() as AuState;
      tokens.pop();
    }
  }

  const locality = tokens.join(' ').trim();
  if (locality === '' || tokens.length > LOCALITY_TOKENS_MAX) return { ok: false, reason: 'digits' };
  // A single-token locality whose only word is a street type ("Street") is not a place; it is the
  // first-token exemption being abused, and there is no suburb of that name.
  if (STREET_TYPE_SET.has(locality.replace(/\.$/, '').toLowerCase())) return { ok: false, reason: 'street' };

  const parts = [locality];
  if (state !== null) parts.push(state);
  if (postcode !== null) parts.push(postcode);
  return { ok: true, value: parts.join(' ') };
}

/**
 * Remove contact detail from text that must otherwise be preserved — the operator's view.
 *
 * This is not the gate; `screenFreeText` is. Redaction exists for the other direction: a message
 * already stored (a contact-form row, a cover note written before the gate existed) read by an
 * operator who needs the sentence and not the phone number, or copied into a support ticket, or
 * shown beside a customer's account. The surrounding words are left exactly as written, because a
 * redaction that reflowed the sentence would be a redaction nobody trusts to quote.
 *
 * Sensitive disclosures are **not** redacted: there is no honest way to remove "I have cancer" and
 * leave the sentence meaning anything, and a laundered disclosure is worse than a refused one. A
 * field that trips `sensitive` must be refused at the gate; this function only takes out what can
 * be taken out.
 */
export function redactFreeText(input: string): string {
  return input
    .replace(globalOf(EMAIL_OBFUSCATED), '[removed]')
    .replace(globalOf(EMAIL), '[removed]')
    .replace(globalOf(PHONE_MOBILE_INTL), '[removed]')
    .replace(globalOf(PHONE_MOBILE), '[removed]')
    .replace(globalOf(PHONE_LANDLINE_INTL), '[removed]')
    .replace(globalOf(PHONE_LANDLINE), '[removed]')
    .replace(globalOf(PO_BOX), '[removed]')
    .replace(globalOf(ADDRESS), '[removed]');
}
