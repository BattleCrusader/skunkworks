/**
 * Fractional Works — the copy.
 *
 * The site is a job board, not a brochure: companies post fractional roles, applicants build a
 * profile and apply, and both sides have a portal. Every page here describes that product and
 * nothing that does not exist. No pricing tier, client name, statistic or testimonial appears in
 * this file, because none of them is known.
 *
 * HTML strings, written as copy and reviewed as copy. The operator's half — settings, page rows,
 * menus, the enquiry form and the per-page search metadata — is `fractionalworks-site.ts`.
 *
 * There is no `<script>`, `<style>` or stylesheet in any body: the look is the `fractional-works`
 * theme package, and `cms_page.body_html` refuses those elements by CHECK.
 */

/* ------------------------------------------------------------------------------- home */

export const HOME: string = `
<section class="fw-hero">
  <div class="fw-hero__grid">
    <div>
      <h1 class="fw-hero__title">A job board for fractional work.</h1>
      <p class="fw-hero__sub">Companies post senior roles measured in days per week. Senior people build a profile, say what they charge a day and how many days they have, and apply directly.</p>
      <div class="fw-actions">
        <a class="fw-btn fw-btn--primary" href="/portal/register?role=advertiser">Post a role</a>
        <a class="fw-btn fw-btn--ghost" href="/portal/register?role=applicant">Find fractional work</a>
      </div>
    </div>
    <aside class="fw-hero__aside">
      <p class="fw-kicker">Newcastle, New South Wales</p>
      <p>Open to companies and applicants across Australia. An account is confirmed by email and a code from an authenticator app before it can post a role or apply for one.</p>
    </aside>
  </div>
</section>

<section class="fw-band" id="what">
  <p class="fw-num">01 — WHAT FRACTIONAL MEANS</p>
  <h2 class="fw-h2">Part of a week, at a senior level.</h2>
  <p class="fw-lede">Fractional work is senior work on part of a week. A role is measured in days per week, not hours or months: one day a week around a decision, two or three days to run a system, five days for a fixed piece of work. The board lists those roles in one place so they can be answered by the people who do the work.</p>
  <div class="fw-cards">
    <article class="fw-card">
      <p class="fw-card__mark">01</p>
      <h3 class="fw-card__title">Days a week</h3>
      <p class="fw-card__body">A role carries a number of days, from one to five, or leaves it open to agree. The shape of the week is set when the role is posted, not a surprise after the first call.</p>
    </article>
    <article class="fw-card">
      <p class="fw-card__mark">02</p>
      <h3 class="fw-card__title">A day rate</h3>
      <p class="fw-card__body">An advertiser sets a day rate on the role; an applicant sets one on their profile. Either side can leave the number empty and discuss it.</p>
    </article>
    <article class="fw-card">
      <p class="fw-card__mark">03</p>
      <h3 class="fw-card__title">Applications, direct</h3>
      <p class="fw-card__body">An application goes from the applicant's portal to the company that posted the role. There is no agency between them.</p>
    </article>
    <article class="fw-card">
      <p class="fw-card__mark">04</p>
      <h3 class="fw-card__title">No contact details</h3>
      <p class="fw-card__body">A profile holds no email address, phone number or postal address. An advertiser sees a profile only when that person applies to one of their roles.</p>
    </article>
  </div>
</section>

<section class="fw-band" id="roles">
  <p class="fw-num">02 — LATEST ROLES</p>
  <h2 class="fw-h2">Roles on the board.</h2>
  <p class="fw-lede">The newest published adverts, drawn from the board's own feed. Each one opens on its own page with the work as the company wrote it.</p>
  <div class="fw-cards" data-gjs-type="list" data-source="jobboard/latest-jobs" data-limit="8">
    <article class="fw-card" data-repeat>
      <h3 class="fw-card__title"><a data-bind-href-slug="slug" data-bind-title="title" href="/jobs/role">Role title</a></h3>
      <p class="fw-card__body" data-bind-subtitle="location">Location</p>
    </article>
    <p class="fw-note" data-empty>No roles are published yet. <a href="/portal/register?role=applicant">Create an applicant profile</a>, make it discoverable, and you can apply as soon as a role is posted.</p>
  </div>
</section>

<section class="fw-band" id="posting">
  <p class="fw-num">03 — IF YOU ARE POSTING</p>
  <h2 class="fw-h2">Post a role in three steps.</h2>
  <div class="fw-steps">
    <div class="fw-step">
      <p class="fw-step__n">01</p>
      <h3 class="fw-step__title">Create an advertiser account.</h3>
      <p>Email, password and the name you want shown. Confirm the address, add a code from an authenticator app, and the account is active.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">02</p>
      <h3 class="fw-step__title">Write the role and set the terms.</h3>
      <p>Title, one line of summary, the work itself, the day rate, the days a week, the location and whether it can be done remotely. The days and the rate are set before the advert is published.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">03</p>
      <h3 class="fw-step__title">Read the applications.</h3>
      <p>Each one arrives in your portal with the applicant's profile and their note. Shortlist or reject it there; the applicant sees the state in their own portal.</p>
    </div>
  </div>
  <p class="fw-note">The detail, including what posting costs: <a href="/for-advertisers">for advertisers</a>.</p>
</section>

<section class="fw-band" id="applying">
  <p class="fw-num">04 — IF YOU ARE LOOKING</p>
  <h2 class="fw-h2">Find work in three steps.</h2>
  <div class="fw-steps">
    <div class="fw-step">
      <p class="fw-step__n">01</p>
      <h3 class="fw-step__title">Build a profile.</h3>
      <p>Your name, a headline, a summary, your day rate, the days a week you are available and whether you work remotely. Every field can be changed later.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">02</p>
      <h3 class="fw-step__title">Choose who can find you.</h3>
      <p>Discoverable profiles can be matched to new roles and can apply. Hidden profiles are not matched and cannot apply. A new profile starts hidden.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">03</p>
      <h3 class="fw-step__title">Apply and track it.</h3>
      <p>Send an application from your portal with the advert's number and a cover note. Your portal lists every application and where it stands.</p>
    </div>
  </div>
  <p class="fw-note">The detail, including what an advertiser sees: <a href="/for-applicants">for applicants</a>.</p>
</section>

<section class="fw-close" id="start">
  <p class="fw-num">05 — START HERE</p>
  <h2 class="fw-h2">Two ways in.</h2>
  <p>If you have a role to fill, create an advertiser account and post it. If you want the work, create an applicant profile and make it discoverable.</p>
  <div class="fw-actions">
    <a class="fw-btn fw-btn--primary" href="/portal/register?role=advertiser">Post a role</a>
    <a class="fw-btn fw-btn--ghost" href="/portal/register?role=applicant">Find fractional work</a>
  </div>
  <p class="fw-note">Already have an account? <a href="/portal/signin">Sign in</a>.</p>
</section>
`;

/* --------------------------------------------------------------------- for advertisers */

export const FOR_ADVERTISERS: string = `
<section class="fw-band">
  <p class="fw-num">FOR ADVERTISERS</p>
  <h1 class="fw-h2">Post a role. Read the applications.</h1>
  <p class="fw-lede">A role on this board is senior work measured in days per week. You write it, set the day rate and the days, and applications arrive in your portal.</p>
  <div class="fw-actions">
    <a class="fw-btn fw-btn--primary" href="/portal/register?role=advertiser">Create an advertiser account</a>
    <a class="fw-btn fw-btn--ghost" href="/portal/signin">Sign in</a>
  </div>
</section>

<section class="fw-band">
  <p class="fw-num">01 — WHAT POSTING DOES</p>
  <h2 class="fw-h2">One advert, on the board.</h2>
  <p class="fw-lede">A published role gets its own address under /jobs and appears in the latest roles on the home page. It stays there until it is closed.</p>
  <div class="fw-steps">
    <div class="fw-step">
      <p class="fw-step__n">01</p>
      <h3 class="fw-step__title">Create an advertiser account.</h3>
      <p>Register with your email, a password and the name you want shown. Tick “Advertise a role”. Confirm the address and add a code from an authenticator app; the account is active once both are done.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">02</p>
      <h3 class="fw-step__title">Post the role and its terms.</h3>
      <p>Title, a one-line summary, the work itself, the day rate in your currency, the days a week, the location and whether it can be done remotely. The days and the rate are chosen before the advert goes live.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">03</p>
      <h3 class="fw-step__title">Read the applications.</h3>
      <p>Each application arrives in your portal with the applicant's profile and the note they wrote. You shortlist or reject it there, and the applicant sees the state of their application in theirs.</p>
    </div>
  </div>
</section>

<section class="fw-band">
  <p class="fw-num">02 — WHAT IT COSTS</p>
  <h2 class="fw-h2">Nothing in the product.</h2>
  <p>There is no checkout, no subscription and no listing fee on this board. An advertiser account, a role and the applications it receives cost nothing here. If a price is introduced it will be stated on this page before a role is posted.</p>
  <p class="fw-note">The board takes no payment details from anyone: there is no card field on registration, on a role or in the portal.</p>
</section>

<section class="fw-band">
  <p class="fw-num">03 — WHAT AN APPLICATION CARRIES</p>
  <h2 class="fw-h2">A profile, read-only.</h2>
  <p class="fw-lede">When someone applies to one of your roles, their profile appears next to the application. It is read-only: name, headline, summary, day rate, availability, remote, location, skills and links.</p>
  <p>There is no email address, phone number or postal address in that view, and no field on the page that could carry one. If an applicant wants to be contacted, they put the means in their summary or in a link — that is their decision, on their profile.</p>
  <p>You decide what happens to the application: shortlist it or reject it. The applicant sees that decision in their portal.</p>
</section>

<section class="fw-band">
  <p class="fw-num">04 — BEFORE YOU POST</p>
  <h2 class="fw-h2">What a role needs.</h2>
  <p class="fw-lede">A role is published only when it has a title, a one-line summary and the work itself. The rest — days, rate, location and remote — is yours to set, and the days and the rate can be left open.</p>
  <div class="fw-cards">
    <article class="fw-card">
      <p class="fw-card__mark">01</p>
      <h3 class="fw-card__title">The work</h3>
      <p class="fw-card__body">What it is, what the first three months look like, and what the person needs to have done before.</p>
    </article>
    <article class="fw-card">
      <p class="fw-card__mark">02</p>
      <h3 class="fw-card__title">The days</h3>
      <p class="fw-card__body">One to five days a week, or left empty when it is negotiable.</p>
    </article>
    <article class="fw-card">
      <p class="fw-card__mark">03</p>
      <h3 class="fw-card__title">The rate</h3>
      <p class="fw-card__body">A day rate in your currency, or left empty and discussed with the applicant.</p>
    </article>
    <article class="fw-card">
      <p class="fw-card__mark">04</p>
      <h3 class="fw-card__title">The place</h3>
      <p class="fw-card__body">A location, and whether the work can be done remotely. Both are stated on the advert.</p>
    </article>
  </div>
</section>
`;

/* ---------------------------------------------------------------------- for applicants */

export const FOR_APPLICANTS: string = `
<section class="fw-band">
  <p class="fw-num">FOR APPLICANTS</p>
  <h1 class="fw-h2">Build a profile. Apply directly.</h1>
  <p class="fw-lede">Your profile is what a company sees when you apply. It states what you do, your day rate, the days a week you have and whether you work remotely. You decide whether it can be found.</p>
  <div class="fw-actions">
    <a class="fw-btn fw-btn--primary" href="/portal/register?role=applicant">Create an applicant account</a>
    <a class="fw-btn fw-btn--ghost" href="/portal/signin">Sign in</a>
  </div>
</section>

<section class="fw-band">
  <p class="fw-num">01 — YOUR PROFILE</p>
  <h2 class="fw-h2">What it holds, and who writes it.</h2>
  <div class="fw-cards">
    <article class="fw-card">
      <p class="fw-card__mark">01</p>
      <h3 class="fw-card__title">The work</h3>
      <p class="fw-card__body">A headline and a summary. Two or three sentences about what you have run and what you want next is enough.</p>
    </article>
    <article class="fw-card">
      <p class="fw-card__mark">02</p>
      <h3 class="fw-card__title">The terms</h3>
      <p class="fw-card__body">Your day rate in your currency, the days a week you are available, and whether you work remotely. Leave the rate empty if you would rather discuss it.</p>
    </article>
    <article class="fw-card">
      <p class="fw-card__mark">03</p>
      <h3 class="fw-card__title">The switch</h3>
      <p class="fw-card__body">Discoverable or hidden. Discoverable profiles may be matched to new roles and can apply. Hidden profiles are not matched and cannot apply.</p>
    </article>
    <article class="fw-card">
      <p class="fw-card__mark">04</p>
      <h3 class="fw-card__title">No contact details</h3>
      <p class="fw-card__body">There is no email address, phone number or postal address on a profile. An advertiser sees it only when you apply to their role.</p>
    </article>
  </div>
</section>

<section class="fw-band" id="discoverability">
  <p class="fw-num">02 — DISCOVERABILITY</p>
  <h2 class="fw-h2">Discoverable or hidden.</h2>
  <p class="fw-lede">One setting with two states, changed on your portal page whenever you want.</p>
  <div class="fw-cols">
    <p><strong>Discoverable.</strong> Your profile may be matched against new roles, and you can apply.</p>
    <p><strong>Hidden.</strong> You are not matched against new roles, and you cannot apply. Your profile stays in your account, unseen by advertisers.</p>
  </div>
  <p class="fw-note">A new profile starts hidden, so set it to discoverable before you apply to anything.</p>
</section>

<section class="fw-band" id="applications">
  <p class="fw-num">03 — APPLYING</p>
  <h2 class="fw-h2">One role, one application.</h2>
  <div class="fw-steps">
    <div class="fw-step">
      <p class="fw-step__n">01</p>
      <h3 class="fw-step__title">Find a role.</h3>
      <p>Roles are listed on the home page and each has its own page under /jobs, with the work as the company wrote it.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">02</p>
      <h3 class="fw-step__title">Send the application.</h3>
      <p>From your portal: the advert's number and a cover note saying what you would bring to that role. The note goes to the company with your profile.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">03</p>
      <h3 class="fw-step__title">Track it.</h3>
      <p>Your portal lists every application and its state: submitted, shortlisted or rejected. The same page holds your profile and the discoverability switch.</p>
    </div>
  </div>
  <p class="fw-note">One application per role. A second application for the same advert is refused. If your account will not activate, write to __SUPPORT_EMAIL__.</p>
</section>
`;

/* ------------------------------------------------------------------------- how it works */

export const HOW_IT_WORKS: string = `
<section class="fw-band">
  <p class="fw-num">HOW IT WORKS</p>
  <h1 class="fw-h2">Two accounts, one board.</h1>
  <p class="fw-lede">Advertisers post roles; applicants build a profile and apply. The board carries the advert, the profile and the application between them, and nothing else.</p>
</section>

<section class="fw-band">
  <p class="fw-num">01 — IF YOU ARE POSTING</p>
  <h2 class="fw-h2">From account to applications.</h2>
  <div class="fw-steps">
    <div class="fw-step">
      <p class="fw-step__n">01</p>
      <h3 class="fw-step__title">Register as an advertiser.</h3>
      <p>An email address, a password, the name you want shown, and the advertiser role. Confirm the address and add a code from an authenticator app.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">02</p>
      <h3 class="fw-step__title">Post the role.</h3>
      <p>The work, the days a week, the day rate, the location and whether it is remote. Only a published role appears on the board.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">03</p>
      <h3 class="fw-step__title">Read and decide.</h3>
      <p>Applications land in your portal with the profile and the note. Shortlist or reject each one; the applicant sees the decision in their portal.</p>
    </div>
  </div>
</section>

<section class="fw-band">
  <p class="fw-num">02 — IF YOU ARE LOOKING</p>
  <h2 class="fw-h2">From profile to application.</h2>
  <div class="fw-steps">
    <div class="fw-step">
      <p class="fw-step__n">01</p>
      <h3 class="fw-step__title">Register as an applicant.</h3>
      <p>An email address, a password and the name you want on your profile. Confirm the address and add a code from an authenticator app.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">02</p>
      <h3 class="fw-step__title">Write the profile and set it discoverable.</h3>
      <p>Headline, summary, day rate, days a week available and remote. Discoverable is what lets the board match you to new roles and what lets you apply.</p>
    </div>
    <div class="fw-step">
      <p class="fw-step__n">03</p>
      <h3 class="fw-step__title">Apply and track.</h3>
      <p>Send the advert's number and a cover note from your portal. Every application and its state is listed on the same page as your profile.</p>
    </div>
  </div>
</section>

<section class="fw-band">
  <p class="fw-num">03 — WHAT THE BOARD DOES NOT DO</p>
  <h2 class="fw-h2">No recruiter, no database.</h2>
  <div class="fw-cols">
    <p><strong>No shortlist.</strong> A role is answered by the people who apply to it. There is no search across profiles and no folder of CVs.</p>
    <p><strong>No contact details.</strong> A profile carries no email address, phone number or postal address. An advertiser sees it only when that person applies.</p>
    <p><strong>No automatic applications.</strong> Every application is sent by the applicant, to one role, with a note they wrote.</p>
  </div>
</section>

<section class="fw-band" id="questions">
  <p class="fw-num">04 — QUESTIONS</p>
  <h2 class="fw-h2">Before you start.</h2>
  <div class="fw-faq">
    <details class="fw-faq__item"><summary class="fw-faq__q">What does fractional mean here?</summary><div class="fw-faq__a"><p>Part-time senior work, measured in days per week: one day a week around a single decision, two or three days to run a system, five for a fixed piece of work.</p></div></details>
    <details class="fw-faq__item"><summary class="fw-faq__q">Who can see my profile?</summary><div class="fw-faq__a"><p>An advertiser sees your profile only when you apply to one of their roles. A discoverable profile may also be matched against new roles; a hidden profile is not matched and cannot apply. The board never shows an email address, phone number or postal address.</p></div></details>
    <details class="fw-faq__item"><summary class="fw-faq__q">Does posting a role cost anything?</summary><div class="fw-faq__a"><p>No. There is no checkout, no subscription and no listing fee on the board. If a price is introduced it will be stated on the advertiser page before a role is posted.</p></div></details>
    <details class="fw-faq__item"><summary class="fw-faq__q">How do I apply for a role?</summary><div class="fw-faq__a"><p>Create an applicant account, make your profile discoverable, then send an application from your portal: the advert's number and a cover note. Your portal lists the state of every application.</p></div></details>
    <details class="fw-faq__item"><summary class="fw-faq__q">Are you a recruiter?</summary><div class="fw-faq__a"><p>No. The board lists roles and carries applications between the company that posted the role and the person who applied. There is no shortlist and no placement.</p></div></details>
    <details class="fw-faq__item"><summary class="fw-faq__q">Where is the board run from?</summary><div class="fw-faq__a"><p>Newcastle, New South Wales. It is open to companies and applicants across Australia.</p></div></details>
  </div>
</section>
`;

/* -------------------------------------------------------------------------------- about */

export const ABOUT: string = `
<section class="fw-band">
  <p class="fw-num">ABOUT</p>
  <h1 class="fw-h2">Who runs this board.</h1>
  <p class="fw-lede">Fractional Works is a job board for part-time senior work, run from Newcastle, New South Wales.</p>
  <div class="fw-prose">
    <p>The board is operated by Fractional Works (ABN __ABN__), from Newcastle, New South Wales. It exists to put fractional roles in one place: companies state the work and the days, and senior people answer directly. It is not a recruitment agency, and it does not represent either side in a negotiation.</p>
    <p>Profiles carry no contact details. There is no email address, no phone number and no postal address on a profile, and no field on an advertiser's view that could hold one. An advertiser sees a profile only when that person applies to one of their roles. What they see is the profile the applicant wrote: name, headline, summary, day rate, availability, remote, location, skills and links.</p>
    <p>Applying is the applicant's decision, one advert at a time. Discoverability is a separate decision: a discoverable profile may be matched against new roles and is needed to apply; a hidden one is neither matched nor able to apply. Both are changed in the portal, by the person who owns the profile.</p>
    <p>If something on the board is wrong — a role that is closed, an application that did not arrive, an account that will not activate — write to __BUSINESS_EMAIL__ and we will look at it.</p>
  </div>
  <ul class="fw-contact__list">
    <li><span>Email</span><a href="mailto:__BUSINESS_EMAIL__">__BUSINESS_EMAIL__</a></li>
    <li><span>Phone</span>__BUSINESS_PHONE__</li>
    <li><span>ABN</span>__ABN__</li>
    <li><span>Where</span>Newcastle, New South Wales</li>
  </ul>
</section>
`;

/* ------------------------------------------------------------------------------ contact */

export const CONTACT: string = `
<section class="fw-band">
  <p class="fw-num">CONTACT</p>
  <h1 class="fw-h2">Questions about the board.</h1>
  <p class="fw-lede">A role, an account, an application, or something that did not work. Tell us which, and what happened.</p>
  <div class="fw-contact">
    <ul class="fw-contact__list">
      <li><span>Email</span><a href="mailto:__BUSINESS_EMAIL__">__BUSINESS_EMAIL__</a></li>
      <li><span>Phone</span>__BUSINESS_PHONE__</li>
      <li><span>ABN</span>__ABN__</li>
    </ul>
    <div data-skw-form="contact/contact" data-skw-label-name="Name" data-skw-label-email="Email" data-skw-label-company="Company" data-skw-label-message="What's the question?" data-skw-submit="Send it" data-skw-thanks="Thanks — your message is on its way. We reply to the address you left."></div>
    <p class="fw-form__alt">Prefer email? __BUSINESS_EMAIL__</p>
    <p class="fw-note">For a role, include its number. For an account, include the address you registered with.</p>
  </div>
</section>
`;

/* ---------------------------------------------------------------------------------- faq */

export interface FaqEntry {
  q: string;
  a: string;
}

/** The same questions `/how-it-works` renders, so the FAQPage JSON-LD is the page's own text. */
export const FAQ: FaqEntry[] = [
  {
    q: 'What does fractional mean here?',
    a: 'Part-time senior work, measured in days per week: one day a week around a single decision, two or three days to run a system, five for a fixed piece of work.',
  },
  {
    q: 'Who can see my profile?',
    a: 'An advertiser sees your profile only when you apply to one of their roles. A discoverable profile may also be matched against new roles; a hidden profile is not matched and cannot apply. The board never shows an email address, phone number or postal address.',
  },
  {
    q: 'Does posting a role cost anything?',
    a: 'No. There is no checkout, no subscription and no listing fee on the board. If a price is introduced it will be stated on the advertiser page before a role is posted.',
  },
  {
    q: 'How do I apply for a role?',
    a: "Create an applicant account, make your profile discoverable, then send an application from your portal: the advert's number and a cover note. Your portal lists the state of every application.",
  },
  {
    q: 'Are you a recruiter?',
    a: 'No. The board lists roles and carries applications between the company that posted the role and the person who applied. There is no shortlist and no placement.',
  },
  {
    q: 'Where is the board run from?',
    a: 'Newcastle, New South Wales. It is open to companies and applicants across Australia.',
  },
];

/* --------------------------------------------------------------------------------- meta */

export const META = {
  home: {
    title: 'Fractional work, listed by the day — Fractional Works',
    description:
      'A job board for fractional work. Companies post senior roles measured in days per week, with a day rate; applicants build a profile and apply directly.',
  },
  advertisers: {
    title: 'Post a fractional role — Fractional Works',
    description:
      'Post a senior role measured in days per week. Set the day rate and the days up front; applications arrive in your portal with the applicant’s profile, read-only.',
  },
  applicants: {
    title: 'Find fractional work — Fractional Works',
    description:
      'Build a profile with your day rate, days a week, availability and remote preference. Control whether you are discoverable, apply to roles and track applications.',
  },
  how: {
    title: 'How the board works — Fractional Works',
    description:
      'How posting a role and applying for one work on Fractional Works: accounts, advert terms, discoverability, applications and what the board does not do.',
  },
  about: {
    title: 'About — Fractional Works',
    description:
      'Fractional Works is a job board for part-time senior work, run from Newcastle, New South Wales. Profiles carry no contact details.',
  },
  contact: {
    title: 'Contact — Fractional Works',
    description:
      'Questions about a role, an account or an application? Write to Fractional Works and we will look at it.',
  },
};
