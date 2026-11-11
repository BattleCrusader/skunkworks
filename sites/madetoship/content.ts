/**
 * Made to Ship — the copy.
 *
 * Words only. The page rows, menus, settings and search metadata live in `site.ts`; this file is
 * what a person reads. Every business detail that must be real before the site goes live is a
 * `__TOKEN__` here and a constant in `site.ts` (`CONFIG`), so nothing is invented at render time.
 *
 * The voice is the brand's: blunt, specific, allergic to adjectives. "Software, delivered." is
 * the whole promise, and every page is an argument for it that a reader can check.
 */

export const HOME = `
<section class="hero">
  <div class="hero__copy">
    <p class="eyebrow">Made to Ship · Software agency</p>
    <h1 class="display">We ship.<br><span class="display__accent">Everything else is a deck.</span></h1>
    <p class="lede">A senior-only software agency. You bring a problem and a date; we write the code, put it in
      production, and hand you the repository. Fixed scope, a working demo every second Friday, and no
      account manager standing between you and the people building it.</p>
    <p class="actions">
      <a class="btn" href="/contact">Start a project</a>
      <a class="btn btn--ghost" href="/process">See how a project runs</a>
    </p>
    <p class="note">Minimum engagement __MIN_PROJECT__ · first demo in two weeks</p>
  </div>
  <aside class="ticket" aria-label="How we work, at a glance">
    <p class="ticket__head">Engagement ticket</p>
    <dl class="ticket__list">
      <div><dt>Scope</dt><dd>Fixed, written before code</dd></div>
      <div><dt>Cadence</dt><dd>Two-week sprints, Friday demo</dd></div>
      <div><dt>Team</dt><dd>Senior engineers only</dd></div>
      <div><dt>Output</dt><dd>Working software in production</dd></div>
      <div><dt>You own</dt><dd>Repository, infrastructure, docs</dd></div>
    </dl>
    <p class="stamp">Delivered</p>
  </aside>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">01 — The manifest</p>
    <h2>Everything we do, one line each.</h2>
  </div>
  <div class="index" data-source="menu/menu-main" data-limit="20">
    <ul class="index__list">
      <li class="index__row" data-repeat>
        <span class="index__num" data-bind-num="position"></span>
        <a class="index__link" data-bind-href-target="href" data-bind-label="label">A page</a>
        <span class="index__go" aria-hidden="true">↗</span>
      </li>
    </ul>
    <p class="index__empty" data-empty>No pages are published yet.</p>
  </div>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">02 — Capabilities</p>
    <h2>Three kinds of work, one standard.</h2>
    <p class="section-head__note">We take on the projects where the deliverable is software in production,
      not a recommendation. If the honest answer is a smaller job, we will quote the smaller job.</p>
  </div>
  <div class="cards">
    <article class="card">
      <p class="card__num">01</p>
      <h3>Product engineering</h3>
      <p>Web applications people pay for: accounts, billing, dashboards, the unglamorous parts that
        decide whether a product survives its first hundred customers.</p>
      <p class="card__meta"><a href="/services">What that includes</a></p>
    </article>
    <article class="card">
      <p class="card__num">02</p>
      <h3>Platforms &amp; integrations</h3>
      <p>Money in, money out, data where it needs to be. Stripe, accounting, CRM, warehouses, queues —
        with an API other teams can build against and an operator can debug at 2am.</p>
      <p class="card__meta"><a href="/services">What that includes</a></p>
    </article>
    <article class="card">
      <p class="card__num">03</p>
      <h3>Rescue &amp; stabilisation</h3>
      <p>Inherited codebases and releases that keep slipping. We stop the bleeding, write the tests that
        make change safe again, and hand back something your own team can run.</p>
      <p class="card__meta"><a href="/services">What that includes</a></p>
    </article>
  </div>
</section>

<section class="band band--ink">
  <div class="section-head">
    <p class="eyebrow">03 — What we promise</p>
    <h2>Five sentences we will not walk back.</h2>
  </div>
  <ol class="promises">
    <li><span>A working demo every second Friday.</span> Not a status update — a URL you can click.</li>
    <li><span>You own everything.</span> Repository, infrastructure, documentation. No proprietary layer that only we can operate.</li>
    <li><span>Senior engineers on the keyboard.</span> Nobody learns your domain on your budget.</li>
    <li><span>A written scope before anyone opens an editor.</span> What is in, what is out, what it costs, when it ships.</li>
    <li><span>If we cannot ship it, we say so before you pay.</span> A declined project is cheaper than a failed one.</li>
  </ol>
</section>

<section class="band band--tight">
  <div class="cta">
    <div>
      <p class="eyebrow">04 — Next</p>
      <h2>Tell us what is stuck.</h2>
      <p class="cta__note">One paragraph is enough. You get a reply within one business day, and a written
        scope with a fixed price within three.</p>
    </div>
    <p class="actions"><a class="btn" href="/contact">Start a project</a></p>
  </div>
</section>
`;

export const SERVICES = `
<section class="page-head">
  <p class="eyebrow">Capabilities</p>
  <h1 class="display display--sm">What we build.</h1>
  <p class="lede">Four kinds of engagement. All of them end the same way: software in production that
    your team can operate without us, with the repository, the infrastructure and the documentation in
    your name.</p>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">01 — Product</p>
    <h2>Product engineering</h2>
    <p class="section-head__note">A web application from an idea to paying customers. We work in thin
      slices so the risky part — the part that decides whether this is worth building — is in front of
      real users in weeks, not quarters.</p>
  </div>
  <div class="split">
    <div class="prose">
      <p>Most of what kills a software product is not the feature list. It is the authentication nobody
        wanted to write, the billing edge cases, the export a customer needs on day one, and the
        migrations that break on the third deploy.</p>
      <p>That work is the work. We do it deliberately: a database schema that says what the business
        means, an API with a contract, tests around the paths that cost money, and a deploy you can
        roll back.</p>
    </div>
    <ul class="spec">
      <li><span>Interface</span>Server-rendered pages, accessible by default, fast on a phone</li>
      <li><span>Accounts</span>Sessions, passwordless or password + second factor, roles</li>
      <li><span>Billing</span>Stripe subscriptions, webhooks, proration, dunning, the customer portal</li>
      <li><span>Data</span>Postgres or SQLite, migrations you can run forwards and backwards</li>
      <li><span>Operations</span>CI, staging, backups, monitoring, a runbook someone can follow</li>
    </ul>
  </div>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">02 — Platform</p>
    <h2>Platforms &amp; integrations</h2>
    <p class="section-head__note">The systems that move money and data between the tools a business
      already runs on. Boring, observable, and safe to change.</p>
  </div>
  <div class="split">
    <div class="prose">
      <p>An integration is a promise about failure. The provider will time out, the webhook will arrive
        twice, the currency will be wrong once, and someone will need to reconcile it by hand. We design
        for that with idempotency keys, an event log, a retry policy and an operator screen, instead of
        discovering it in production.</p>
      <p>When other teams need to build on top, they get a documented API with a version and a
        deprecation policy — not a shared database and a phone call.</p>
    </div>
    <ul class="spec">
      <li><span>Payments</span>Stripe, refunds, payouts, reconciliation against the ledger</li>
      <li><span>Accounting</span>Xero, QuickBooks, invoice and credit-note synchronisation</li>
      <li><span>Data</span>Warehouse loads, CDC, nightly reconciliation, one source of truth</li>
      <li><span>Events</span>Queues, workers, idempotent handlers, dead-letter handling</li>
      <li><span>Interfaces</span>REST or RPC with OpenAPI, auth, rate limits, versioning</li>
    </ul>
  </div>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">03 — Applied AI</p>
    <h2>AI features that survive contact with users</h2>
    <p class="section-head__note">Retrieval over your own documents, an assistant inside a workflow, a
      classifier that replaces a queue of manual decisions. Measured, guarded, and priced per request.</p>
  </div>
  <div class="split">
    <div class="prose">
      <p>A language model is a component, not a product. It is non-deterministic, it fails in ways that
        look like success, and its cost scales with use rather than with seats. All three facts have to
        be designed around, or the feature ships and then quietly gets switched off.</p>
      <p>We build the evaluation set before the prompt, keep a deterministic path for the cases that
        matter, cap spend per tenant, and log what the model was given so a wrong answer can be
        explained rather than guessed at.</p>
    </div>
    <ul class="spec">
      <li><span>Grounding</span>Chunking, embeddings, retrieval tuned against real questions</li>
      <li><span>Evaluation</span>A labelled set, a score, a regression gate before every deploy</li>
      <li><span>Guardrails</span>Schema-constrained output, refusal paths, human review where it counts</li>
      <li><span>Cost</span>Per-tenant budgets, caching, smaller models where they are enough</li>
      <li><span>Privacy</span>Your documents stay in your infrastructure; no training on your data</li>
    </ul>
  </div>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">04 — Rescue</p>
    <h2>Rescue &amp; stabilisation</h2>
    <p class="section-head__note">A release that keeps slipping, a codebase nobody wants to touch, an
      agency that left mid-project. We start by making change safe again.</p>
  </div>
  <div class="split">
    <div class="prose">
      <p>The first two weeks are diagnosis, not heroics: what runs, what is deployed, what the tests
        actually cover, where the money leaks, and what a rollback would look like today. You get that
        as a written assessment with a costed plan, whether or not you continue with us.</p>
      <p>Then we stabilise in order of risk — the payment path first, then the parts that wake people up
        at night, then the code quality that makes every future change slow.</p>
    </div>
    <ul class="spec">
      <li><span>Week one</span>Repository, infrastructure and deploy audit; a written risk list</li>
      <li><span>Week two</span>The first fix in production, with a test that would have caught it</li>
      <li><span>Then</span>Payment and auth paths hardened, monitoring, alerts, runbook</li>
      <li><span>Handover</span>Documentation, pairing sessions, and a plan your team owns</li>
    </ul>
  </div>
</section>

<section class="band band--tight">
  <div class="cta">
    <div>
      <p class="eyebrow">Next</p>
      <h2>Not sure which of these you need?</h2>
      <p class="cta__note">Describe the problem in a paragraph. We will tell you which one it is — or
        that it is none of them.</p>
    </div>
    <p class="actions"><a class="btn" href="/contact">Talk to an engineer</a></p>
  </div>
</section>
`;

export const PROCESS = `
<section class="page-head">
  <p class="eyebrow">Process</p>
  <h1 class="display display--sm">Six weeks from kickoff to production.</h1>
  <p class="lede">Not every project fits in six weeks, and we say so at the scope stage rather than at
    week five. What does not change is the shape: a written scope, two-week sprints with a demo you can
    click, and a launch that leaves your team owning the result.</p>
</section>

<section class="band">
  <ol class="steps">
    <li class="step">
      <p class="step__when">Week 0</p>
      <div class="step__body">
        <h3>Scope</h3>
        <p>One working day with the people who decide. Out comes a written scope: the outcome, the
          screens, the data, what is explicitly out of scope, the fixed price and the dates. You sign
          it before anyone writes code.</p>
      </div>
    </li>
    <li class="step">
      <p class="step__when">Weeks 1–2</p>
      <div class="step__body">
        <h3>The thin slice</h3>
        <p>One path through the whole system, end to end: database, API, screen, deploy. It is in
          staging by day three and demoed on the second Friday. Everything after this is depth, not
          discovery.</p>
      </div>
    </li>
    <li class="step">
      <p class="step__when">Weeks 3–4</p>
      <div class="step__body">
        <h3>The real workflow</h3>
        <p>The ugly cases: the refund, the duplicate webhook, the customer who has two accounts, the
          export the accountant actually needs. This is the sprint where a product starts to feel
          finished.</p>
      </div>
    </li>
    <li class="step">
      <p class="step__when">Week 5</p>
      <div class="step__body">
        <h3>Hardening</h3>
        <p>Authentication and payment paths tested, backups restored once on purpose, alerts wired to a
          human, a runbook written by the person who will be on call. Performance measured, not assumed.</p>
      </div>
    </li>
    <li class="step">
      <p class="step__when">Week 6</p>
      <div class="step__body">
        <h3>Launch</h3>
        <p>Production, with a rollback rehearsed. Repository, infrastructure and documentation handed
          over in your accounts. Two weeks of support are included, then you decide whether you need us
          again.</p>
      </div>
    </li>
  </ol>
</section>

<section class="band band--ink">
  <div class="section-head">
    <p class="eyebrow">Inside a sprint</p>
    <h2>What a fortnight looks like.</h2>
  </div>
  <div class="cards cards--ink">
    <article class="card">
      <p class="card__num">Mon</p>
      <h3>Plan</h3>
      <p>Forty-five minutes. What ships by Friday, what we are deliberately not doing, what we need
        from you and by when.</p>
    </article>
    <article class="card">
      <p class="card__num">Tue–Thu</p>
      <h3>Build</h3>
      <p>Code, tests, review. A short written note each afternoon so nothing waits a week to surface.</p>
    </article>
    <article class="card">
      <p class="card__num">Fri</p>
      <h3>Demo</h3>
      <p>You click it yourself, on a staging URL. Written notes follow, and the next sprint is adjusted
        against what you saw.</p>
    </article>
  </div>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">Working together</p>
    <h2>The rules we hold ourselves to.</h2>
  </div>
  <div class="split">
    <div class="prose">
      <p>You talk to the engineers. There is no layer of account management translating what you said
        into a ticket, and no weekly status call that repeats what is already written down.</p>
      <p>Decisions are written where you can find them: scope, architecture, releases, risks. If a
        decision turns out wrong, it is amended in the same place, with the date — not quietly
        forgotten.</p>
    </div>
    <ul class="spec">
      <li><span>Access</span>A shared channel and a shared board; you see the work as we do</li>
      <li><span>Overlap</span>At least four hours a day with your timezone</li>
      <li><span>Reporting</span>Written, weekly, three lines: shipped, blocked, next</li>
      <li><span>Change</span>A change to scope is priced in writing before it is built</li>
      <li><span>Exit</span>Any sprint boundary, two weeks notice, everything handed over</li>
    </ul>
  </div>
</section>

<section class="band band--tight">
  <div class="cta">
    <div>
      <p class="eyebrow">Next</p>
      <h2>See the engagements.</h2>
      <p class="cta__note">What a discovery sprint, a build sprint and a retainer cost, and what each
        one is for.</p>
    </div>
    <p class="actions"><a class="btn" href="/engagements">Engagements &amp; pricing</a></p>
  </div>
</section>
`;

export const ENGAGEMENTS = `
<section class="page-head">
  <p class="eyebrow">Engagements</p>
  <h1 class="display display--sm">How to buy software from us.</h1>
  <p class="lede">Three ways in, all priced before the work starts, in Australian dollars. No hourly
    billing, no estimate that grows a zero, no invoice for a meeting.</p>
</section>

<section class="band">
  <div class="plans">
    <article class="plan">
      <p class="plan__kind">One week</p>
      <h2 class="plan__name">Discovery sprint</h2>
      <p class="plan__price">__DISCOVERY_FEE__<span>one week, fixed</span></p>
      <p class="plan__for">For a problem that is real but not yet specified: an idea to pressure-test, a
        system to assess, a decision between two paths.</p>
      <ul class="plan__list">
        <li>One day with your team, the rest in the code or the data</li>
        <li>A written scope with screens, data model and risks</li>
        <li>A fixed price and a date for the build</li>
        <li>A prototype where a prototype answers the question</li>
      </ul>
      <p class="plan__note">Credited in full against the build if you continue.</p>
    </article>
    <article class="plan plan--feature">
      <p class="plan__kind">Most projects</p>
      <h2 class="plan__name">Build sprint</h2>
      <p class="plan__price">__SPRINT_FEE__<span>per two-week sprint</span></p>
      <p class="plan__for">Two senior engineers, two weeks, one written scope. A demo you can click
        every second Friday, and production inside six weeks.</p>
      <ul class="plan__list">
        <li>Two senior engineers full-time on your project</li>
        <li>A third engineer, when the work needs one: __EXTRA_ENGINEER__ a sprint</li>
        <li>Staging URL from day three; production from week six</li>
        <li>Tests, CI, monitoring and a runbook included</li>
        <li>Cancel any sprint boundary with two weeks notice</li>
      </ul>
      <p class="plan__note">Minimum one sprint: __MIN_PROJECT__. Invoiced per sprint, seven-day terms.</p>
    </article>
    <article class="plan">
      <p class="plan__kind">Ongoing</p>
      <h2 class="plan__name">Retainer</h2>
      <p class="plan__price">__RETAINER_FEE__<span>per month, from</span></p>
      <p class="plan__for">For the product that already ships and needs a senior team on call: the next
        feature, the incident, the migration nobody has time for.</p>
      <ul class="plan__list">
        <li>Four senior days a month, booked in advance</li>
        <li>__DAY_RATE__ a day beyond that</li>
        <li>Priority on incidents during business hours</li>
        <li>Monthly written review: risk, cost, next</li>
        <li>Unused days roll over one month</li>
      </ul>
      <p class="plan__note">Three-month minimum, then monthly.</p>
    </article>
  </div>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">The fine print, in plain English</p>
    <h2>Terms we do not negotiate, so nobody has to.</h2>
  </div>
  <div class="split">
    <ul class="spec">
      <li><span>Payment</span>Invoices on the first business day, seven-day terms</li>
      <li><span>Currency</span>Australian dollars, invoiced from Australia with the ABN on the
        invoice; prices exclude GST where GST applies</li>
      <li><span>Expenses</span>Passed through at cost with receipts, never marked up</li>
      <li><span>IP</span>Yours on payment, including work in progress</li>
      <li><span>Confidentiality</span>Mutual NDA on request, signed same day</li>
    </ul>
    <div class="prose">
      <p>Fixed scope means the price does not move because we were slow. If the scope has to change,
        you get a written change with a price before anything is built, and you can decline it.</p>
      <p>We do not take equity in place of fees, and we do not work on commission. It is a bad trade
        for both sides: it turns an engineering decision into a financial one.</p>
    </div>
  </div>
</section>

<section class="band band--tight">
  <div class="cta">
    <div>
      <p class="eyebrow">Next</p>
      <h2>Get a fixed price.</h2>
      <p class="cta__note">A paragraph about the problem is enough for us to tell you what it would
        take, and whether we are the right shop for it.</p>
    </div>
    <p class="actions"><a class="btn" href="/contact">Start a project</a></p>
  </div>
</section>
`;

export const ABOUT = `
<section class="page-head">
  <p class="eyebrow">About</p>
  <h1 class="display display--sm">Small, senior, accountable.</h1>
  <p class="lede">Made to Ship is a compact team of engineers who would rather finish something than
    describe it. We started it because the work we wanted — a real problem, a real deadline, and nobody
    between us and the person who knows the answer — kept getting buried inside companies built to sell
    headcount.</p>
</section>

<section class="band">
  <div class="split split--wide">
    <div class="prose">
      <h2>Why we exist</h2>
      <p>Agencies get paid for hours and consultancies get paid for slides. Both incentives point away
        from the only thing a client actually wants: software that works, running somewhere, with
        somebody accountable for it on Monday morning.</p>
      <p>So we structure around shipping. Fixed scope, so the incentive is to be right rather than to be
        long. Senior engineers only, so the person who understood the problem is the person who solved
        it. And a written handover at the end, because a project that cannot leave is not finished.</p>
      <h2>How we are set up</h2>
      <p>Remote-first, with at least four hours of overlap with your working day. Small teams — one or
        two engineers and whoever is needed from your side. No subcontractors, no offshore chain, no
        junior learning on your budget.</p>
      <p>The stack is deliberately unremarkable: TypeScript and Node, Postgres or SQLite, Astro and React
        on the front end, Stripe for billing, Docker and a boring host. Boring technology is a feature —
        it means the next person can pick it up.</p>
    </div>
    <div>
      <div class="section-head section-head--tight">
        <p class="eyebrow">Principles</p>
        <h2 class="h-sm">What we believe about the work.</h2>
      </div>
      <ol class="promises promises--light">
        <li><span>Ship a thin slice first.</span> The risk is in the unknown, and a demo retires it faster than a document.</li>
        <li><span>Boring technology, chosen on purpose.</span> Novelty is a cost you pay for years.</li>
        <li><span>Boring is not careless.</span> Types, tests, migrations, backups, alerts — the parts nobody demos.</li>
        <li><span>The person who writes the code talks to you.</span> Every translation loses something.</li>
        <li><span>If it is not in production, it is not done.</span> Merged is not shipped.</li>
      </ol>
    </div>
  </div>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">Fit</p>
    <h2>Who we are not.</h2>
  </div>
  <div class="cards">
    <article class="card">
      <h3>Not a body shop</h3>
      <p>We do not rent engineers by the month for someone else to direct. We are accountable for an
        outcome, which means we own the technical decisions inside the scope.</p>
    </article>
    <article class="card">
      <h3>Not a design agency</h3>
      <p>We build interfaces that are clear, accessible and fast, working from your brand or alongside
        your designer. A brand identity is a different craft.</p>
    </article>
    <article class="card">
      <h3>Not a consultancy</h3>
      <p>You will not get a strategy deck and a recommendation to hire someone. If the honest answer is
        that you should not build this, we will say so in the first conversation.</p>
    </article>
  </div>
</section>

<section class="band">
  <div class="section-head">
    <p class="eyebrow">Where to go next</p>
    <h2 class="h-sm">The rest of the site.</h2>
  </div>
  <div class="index" data-source="menu/menu-footer" data-limit="8">
    <ul class="index__list">
      <li class="index__row" data-repeat>
        <span class="index__num" data-bind-num="position"></span>
        <a class="index__link" data-bind-href-target="href" data-bind-label="label">A page</a>
        <span class="index__go" aria-hidden="true">↗</span>
      </li>
    </ul>
    <p class="index__empty" data-empty>No pages are published yet.</p>
  </div>
</section>

<section class="band band--tight">
  <div class="cta">
    <div>
      <p class="eyebrow">Next</p>
      <h2>Talk to the people who would build it.</h2>
      <p class="cta__note">No sales engineer, no discovery call funnel. An engineer reads what you send.</p>
    </div>
    <p class="actions"><a class="btn" href="/contact">Get in touch</a></p>
  </div>
</section>
`;

export const CONTACT = `
<section class="page-head">
  <p class="eyebrow">Contact</p>
  <h1 class="display display--sm">Tell us what is stuck.</h1>
  <p class="lede">A paragraph is enough: what the software has to do, who uses it, and when it has to be
    live. An engineer reads it, and you get an answer within one business day — including "we are not
    the right shop for this" when that is the honest answer.</p>
</section>

<section class="band">
  <div class="contact">
    <div class="contact__form">
      <div class="section-head section-head--tight">
        <p class="eyebrow">01 — Project enquiry</p>
        <h2 class="h-sm">Start here.</h2>
      </div>
      <div data-skw-form="contact/contact"
           data-skw-label-name="Your name"
           data-skw-label-email="Email"
           data-skw-label-company="Company (optional)"
           data-skw-label-message="What are you trying to ship?"
           data-skw-submit="Send it"
           data-skw-thanks="Thanks — your message is with us. You will get a reply from an engineer within one business day."></div>
    </div>
    <aside class="contact__aside">
      <p class="stamp stamp--inline">Reply within one business day</p>
      <div class="section-head section-head--tight">
        <p class="eyebrow">02 — Direct</p>
        <h2 class="h-sm">Or skip the form.</h2>
      </div>
      <dl class="spec spec--contact">
        <li><span>Email</span><a href="mailto:__BUSINESS_EMAIL__">__BUSINESS_EMAIL__</a></li>
        <li><span>Phone</span><a href="tel:__BUSINESS_PHONE_HREF__">__BUSINESS_PHONE__</a></li>
        <li><span>LinkedIn</span><a href="__LINKEDIN_URL__">Made to Ship</a></li>
        <li><span>ABN</span>__ABN__</li>
      </dl>
      <div class="section-head section-head--tight">
        <p class="eyebrow">03 — What happens next</p>
      </div>
      <ol class="steps steps--compact">
        <li class="step">
          <p class="step__when">Day 0</p>
          <div class="step__body"><p>We read it. If it is a fit, you get a call booked; if not, you get a
            straight answer and a suggestion of who might help.</p></div>
        </li>
        <li class="step">
          <p class="step__when">Day 1–3</p>
          <div class="step__body"><p>A thirty-minute call with an engineer, then a written scope with a
            fixed price and dates.</p></div>
        </li>
        <li class="step">
          <p class="step__when">Day 3–5</p>
          <div class="step__body"><p>You sign or you do not. If you do, week zero is booked and the first
            demo is a fortnight away.</p></div>
        </li>
      </ol>
    </aside>
  </div>
</section>
`;
