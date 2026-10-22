/**
 * The studio site: a real website for a tenant, seeded from one script.
 *
 * `abc123` had five pages that were test fixtures — a home page that was a menu block, an
 * "About & Co <ltd>" title from S1's seed data, and a "Menu demo" at `/pricing`. This puts a
 * site there: five pages of copy, one stylesheet, a header and footer, a journal with three
 * posts, and the three shipped packages doing the work they were built for.
 *
 * ## Why a script and not the editor
 *
 * The editor is the tenant's tool and it edits **one page at a time**; a site is five pages that
 * have to agree with each other and with one stylesheet. Seeding it is an operator action on a
 * demo tenant, like `skwctl tenant create`, and it is repeatable: run it twice and the site is
 * the same site, because every write is an upsert keyed on the page's path.
 *
 * ## What it writes
 *
 *   cms_settings   site.title, site.footer_text, site.theme_css (the one stylesheet),
 *                  site.header_sticky, site.footer_sticky
 *   cms_page       /, /about, /pricing, /writing, /contact — published, no draft pending
 *   cms_nav        header and footer menus, positions 0..3
 *   p_blog_post    three published posts (the blog package's table)
 *   p_menu_item    four rows, so the menu block on /about draws a site index
 *
 * ## The three packages, used as designed
 *
 *   blog      a detail page at `/blog/{slug}` for every published row, and the "recent posts"
 *             block on `/` and `/writing`
 *   contact   the declared form on `/` and `/contact`; the host draws the fields and posts them
 *             back to the page's own URL
 *   menu      the "site index" list on `/about`
 *
 * Nothing here writes a `<script>` or a `<style>`: the schema refuses both in `body_html`, which
 * is why the stylesheet lives in `site.theme_css` and is emitted for every page by the shell.
 *
 *   npm run seed:studio            # data/ + abc123
 *   node --no-warnings --experimental-strip-types scripts/seed-studio-site.ts --tenant abc123
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SHA = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/* ------------------------------------------------------------------ the stylesheet */

/**
 * One stylesheet for the whole site, in `site.theme_css`.
 *
 * It styles the two things the shell owns (`.site-header`, `.site-menu`, `.site-footer`) and the
 * markup the pages carry (`.s-*`), plus the two shapes a package's output comes back as: a list
 * (`ul.list__items`, which the block resolver fills) and a form (`.skw-form .field`, which the
 * form resolver draws). A per-page `<style>` would have had to repeat all of it five times.
 */
const THEME_CSS = `
:root{--paper:#fbf8f2;--ink:#17150f;--ink2:#3b372e;--muted:#736b5d;--rule:#e3dccc;--accent:#a8451c;--forest:#1f4238}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.66 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-feature-settings:"kern" 1,"liga" 1}
h1,h2,h3,h4{font-family:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-weight:600;letter-spacing:-.02em;line-height:1.1;margin:0 0 .6em}
p{margin:0 0 1.15em}
a{color:inherit}
a:hover{color:var(--accent)}
img{max-width:100%;height:auto;display:block}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:#f1ebdd;padding:.1em .35em;border-radius:2px}

/* ---- the bar ---- */
.site-header{max-width:74rem;margin:0 auto;padding:1.05rem 2.5rem;display:flex;align-items:center;gap:2rem;border-bottom:1px solid var(--rule);background:var(--paper)}
.site-header--sticky{position:sticky;top:0;z-index:20;background:rgba(251,248,242,.94);backdrop-filter:saturate(140%) blur(8px)}
.site-id{display:inline-flex;align-items:center;gap:.7rem;font-family:ui-serif,"Iowan Old Style",Palatino,Georgia,serif;font-size:1.06rem;letter-spacing:.2em;text-transform:uppercase;text-decoration:none;color:var(--ink);font-weight:600}
.site-id:hover{color:var(--ink)}
.site-id img{height:1.9rem;width:auto}
.site-header nav{margin-left:auto;display:flex;align-items:center}
/* The bar's menu: readable sentence case, a hover surface rather than a colour change, the
   current page marked from the body's own path, and the last thing in it — Contact — drawn as
   the one action the bar offers. */
.site-menu{display:flex;flex-wrap:wrap;align-items:center;gap:.15rem;margin:0;padding:0;list-style:none;font-size:.95rem;font-weight:500;letter-spacing:0}
.site-menu li{display:block}
.site-menu a{display:inline-block;padding:.5rem .8rem;color:var(--ink2);text-decoration:none;border-radius:2px;transition:color .14s ease,background-color .14s ease}
.site-menu a:hover{color:var(--ink);background:rgba(23,21,15,.055)}
.site-header .site-menu a[href="/contact"]{margin-left:.9rem;padding:.5rem 1.05rem;border:1px solid var(--ink);color:var(--ink)}
.site-header .site-menu a[href="/contact"]:hover{background:var(--ink);color:var(--paper)}
body[data-page-path="/about"] .site-header .site-menu a[href="/about"],
body[data-page-path="/pricing"] .site-header .site-menu a[href="/pricing"],
body[data-page-path="/writing"] .site-header .site-menu a[href="/writing"],
body[data-page-path="/contact"] .site-header .site-menu a[href="/contact"]{color:var(--ink);background:rgba(23,21,15,.055);box-shadow:inset 0 -2px 0 var(--accent)}
body[data-page-path="/"] .site-header .site-menu a[href="/"]{color:var(--ink)}

/* ---- the page ---- */
main{display:block;max-width:74rem;margin:0 auto;padding:0 2.5rem}
main>section{padding:4.5rem 0;border-bottom:1px solid var(--rule)}
main>section:last-child{border-bottom:0;padding-bottom:5rem}
main p{max-width:60ch;color:var(--ink2)}
main em{font-style:italic;color:var(--accent)}
.s-eyebrow{margin:0 0 1.6rem;font-size:.74rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
.s-hero{padding:5.5rem 0 4rem!important;border-bottom:1px solid var(--rule)}
.s-hero h1{font-size:clamp(2.5rem,6vw,4.5rem);line-height:1.02;letter-spacing:-.035em;max-width:18ch;margin:0 0 2rem}
.s-hero__grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:3.5rem;align-items:start}
.s-lede{font-size:1.2rem;line-height:1.55;color:var(--ink2);max-width:44ch;margin:0}
.s-facts{list-style:none;margin:.4rem 0 0;padding:0;display:grid;gap:.9rem;font-size:.85rem;letter-spacing:.02em;color:var(--muted)}
.s-facts li{display:flex;align-items:baseline;gap:.7rem;border-top:1px solid var(--rule);padding-top:.9rem}
.s-facts b{font-family:ui-serif,Palatino,Georgia,serif;font-size:1.5rem;font-weight:600;color:var(--ink);letter-spacing:-.02em;min-width:2ch}
.s-actions{display:flex;flex-wrap:wrap;gap:.9rem;margin:2.6rem 0 0}
.s-btn{display:inline-flex;align-items:center;gap:.5rem;padding:.95rem 1.5rem;border:1px solid var(--ink);border-radius:2px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;color:var(--ink);background:transparent;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}
.s-btn:hover{color:var(--paper);background:var(--ink);text-decoration:none}
.s-btn--primary{background:var(--ink);color:var(--paper)}
.s-btn--primary:hover{background:var(--accent);border-color:var(--accent);color:var(--paper)}
.s-btn--quiet{border-color:var(--rule);color:var(--ink2)}

.s-section__head{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:3.5rem;align-items:baseline;margin-bottom:2.8rem}
.s-section__head h2{font-size:clamp(1.6rem,3vw,2.4rem);margin:0}
.s-section__head p{margin:0;font-size:1rem}
.s-more{margin:2.4rem 0 0;font-size:.8rem;letter-spacing:.12em;text-transform:uppercase}
.s-more a{text-decoration:none;border-bottom:1px solid var(--accent);padding-bottom:.2rem;color:var(--accent)}

/* work */
.s-work{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2.6rem}
.s-work article{border-top:2px solid var(--ink);padding-top:1.2rem}
.s-work h3{font-size:1.25rem;margin:1.2rem 0 .4rem}
.s-work p{font-size:.95rem;margin:0;color:var(--muted)}
.s-work__meta{font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0}
.s-specimen{height:11rem;position:relative;overflow:hidden;border-radius:1px;display:grid;place-items:center}
.s-specimen span{font-family:ui-serif,Palatino,Georgia,serif;font-size:2.6rem;letter-spacing:.04em;color:rgba(251,248,242,.92)}
.s-specimen--kiln{background:linear-gradient(135deg,#a8451c,#742c12 62%,#3d160a)}
.s-specimen--tide{background:linear-gradient(135deg,#1f4238,#12291f 60%,#0b1a14)}
.s-specimen--chalk{background:linear-gradient(135deg,#cfc7b4,#9d9482 70%,#6f6857)}

/* what we do */
.s-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.s-list li{display:grid;grid-template-columns:4rem minmax(0,14rem) minmax(0,1fr);gap:2rem;padding:1.6rem 0;border-bottom:1px solid var(--rule);align-items:baseline}
.s-list__n{font-size:.78rem;letter-spacing:.14em;color:var(--accent)}
.s-list h3{font-size:1.15rem;margin:0}
.s-list p{margin:0;font-size:.97rem;color:var(--muted);max-width:52ch}

/* journal: what the blog package's block comes back as */
main .list{margin:0}
main .list__items{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
main .list__items li{border-bottom:1px solid var(--rule);padding:0}
main .list__items li>a{display:flex;align-items:baseline;justify-content:space-between;gap:2rem;padding:1.35rem 0;font-family:ui-serif,Palatino,Georgia,serif;font-size:1.28rem;letter-spacing:-.01em;text-decoration:none;color:var(--ink)}
main .list__items li>a::after{content:"→";font-family:ui-sans-serif,system-ui,sans-serif;font-size:.95rem;color:var(--accent);transition:transform .15s ease}
main .list__items li>a:hover{color:var(--accent)}
main .list__items li>a:hover::after{transform:translateX(4px)}
main .list__empty{margin:0;padding:1.4rem 0;border-bottom:1px solid var(--rule);color:var(--muted);font-size:.95rem}

/* the contact form the host draws */
.s-contact{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:4rem;align-items:start}
.s-contact h2{font-size:clamp(1.7rem,3vw,2.5rem)}
.s-contact__note{font-size:.92rem;color:var(--muted);margin-top:2rem}
.s-contact__note b{display:block;font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--ink);margin-bottom:.3rem}
main .skw-form{display:grid;gap:1.5rem;max-width:none}
main .skw-form .field{display:grid;gap:.45rem}
main .skw-form label{font-size:.74rem;letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}
main .skw-form input,main .skw-form textarea{width:100%;background:transparent;border:0;border-bottom:1px solid var(--rule);padding:.55rem 0;font:inherit;font-size:1.02rem;color:var(--ink);border-radius:0}
main .skw-form textarea{min-height:7.5rem;resize:vertical}
main .skw-form input:focus,main .skw-form textarea:focus{outline:0;border-bottom-color:var(--accent)}
main .skw-form button{justify-self:start;margin-top:.6rem;padding:.95rem 1.6rem;border:1px solid var(--ink);background:var(--ink);color:var(--paper);border-radius:2px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
main .skw-form button:hover{background:var(--accent);border-color:var(--accent)}
main .skw-form__thanks{border-left:2px solid var(--forest);padding:.2rem 0 .2rem 1.1rem;color:var(--forest);font-size:1rem}
main .skw-form__error{border-left:2px solid var(--accent);padding:.2rem 0 .2rem 1.1rem;color:var(--accent);margin:0}

/* about */
.s-prose{max-width:62ch}
.s-prose p{font-size:1.06rem}
.s-principles{list-style:none;margin:2.6rem 0 0;padding:0;display:grid;gap:1.4rem}
.s-principles li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1.2rem;align-items:baseline;border-top:1px solid var(--rule);padding-top:1.2rem}
.s-principles b{font-family:ui-serif,Palatino,Georgia,serif;font-size:1.05rem;min-width:8rem;display:block}
.s-principles span{color:var(--muted);font-size:.96rem}
.s-aside{margin:3.4rem 0 0;border-top:1px solid var(--rule);padding-top:1.4rem}
.s-aside h3{font-size:.74rem;letter-spacing:.18em;text-transform:uppercase;font-family:inherit;color:var(--muted);margin:0 0 1rem}
.s-aside .list__items li>a{font-size:1rem;font-family:inherit;letter-spacing:.01em;padding:.7rem 0}

/* pricing */
.s-tiers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2.4rem;margin-top:1rem}
.s-tier{border-top:2px solid var(--ink);padding-top:1.3rem;display:flex;flex-direction:column;gap:.5rem}
.s-tier h3{font-size:1.2rem;margin:0}
.s-tier__price{font-family:ui-serif,Palatino,Georgia,serif;font-size:1.9rem;letter-spacing:-.02em;margin:.3rem 0 .8rem}
.s-tier__price small{font-family:inherit;font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);display:block;margin-top:.2rem}
.s-tier ul{list-style:none;margin:0 0 1.2rem;padding:0;font-size:.95rem;color:var(--ink2);display:grid;gap:.55rem}
.s-tier li{padding-left:1.1rem;position:relative}
.s-tier li::before{content:"—";position:absolute;left:0;color:var(--accent)}
.s-tier--featured{border-top-color:var(--accent)}

/* footer */
/* The footer is one line at desktop width: the sentence on the left, the same four links on
   the right, both on the same baseline. The menu is quieter here than in the bar — it is a
   second way to the same pages, not a second navigation. */
.site-footer{max-width:74rem;margin:0 auto;padding:2.2rem 2.5rem 3.2rem;border-top:1px solid var(--rule);background:transparent;display:flex;flex-wrap:wrap;align-items:baseline;gap:.9rem 2.4rem;font-size:.86rem;color:var(--muted)}
.site-footer__text{margin:0;order:1;flex:1 1 16rem;color:var(--muted)}
.site-footer nav{margin-left:auto;order:2}
.site-footer .site-menu{gap:1.6rem;font-size:.86rem;font-weight:400}
.site-footer .site-menu a{padding:0;color:var(--muted)}
.site-footer .site-menu a:hover{color:var(--ink);background:none;text-decoration:underline;text-underline-offset:3px}
.site-footer .site-menu a[href="/contact"]{margin-left:0;border:0;padding:0;color:var(--muted)}
.site-footer .site-menu a[href="/contact"]:hover{background:none;color:var(--ink)}

@media (max-width:900px){
  .s-hero__grid,.s-section__head,.s-contact{grid-template-columns:minmax(0,1fr);gap:2rem}
  .s-work,.s-tiers{grid-template-columns:minmax(0,1fr);gap:2.2rem}
  .s-list li{grid-template-columns:2.5rem minmax(0,1fr);gap:.8rem 1.2rem}
  .s-list li p{grid-column:2}
  .site-header{padding:.9rem 1.4rem;gap:.8rem;flex-wrap:wrap}
  .site-header nav{margin-left:0;width:100%;overflow-x:auto}
  .site-menu{font-size:.92rem}
  .site-header .site-menu a[href="/contact"]{margin-left:.2rem}
  main{padding:0 1.4rem}
  main>section{padding:3rem 0}
  .s-hero{padding:3.2rem 0 2.6rem!important}
  .site-footer{padding:2rem 1.4rem 2.8rem}
}
`.trim();

/* ------------------------------------------------------------------ the pages */

const HOME = `
<section class="s-hero">
  <p class="s-eyebrow">A studio for small, well-made software</p>
  <h1>Small things,<br><em>made properly.</em></h1>
  <div class="s-hero__grid">
    <p class="s-lede">ABC 123 is a six-person studio. We design and build software that people use every day and rarely talk about — the invoice tool, the booking screen, the dashboard nobody complains about. That is the work we like.</p>
    <ul class="s-facts">
      <li><b>18</b><span>products shipped since 2016</span></li>
      <li><b>6</b><span>designers and engineers, no subcontractors</span></li>
      <li><b>2</b><span>studios: Melbourne and Lisbon</span></li>
    </ul>
  </div>
  <p class="s-actions"><a class="s-btn s-btn--primary" href="/contact">Start a project</a><a class="s-btn s-btn--quiet" href="/writing">Read the journal</a></p>
</section>

<section id="work">
  <div class="s-section__head">
    <h2>Selected work</h2>
    <p>Three of the things we finished this year. Every one of them is still in daily use, which is the only review we care about.</p>
  </div>
  <div class="s-work">
    <article>
      <p class="s-work__meta">Kiln · 2026</p>
      <div class="s-specimen s-specimen--kiln"><span>01</span></div>
      <h3>A quoting tool for a ceramics studio</h3>
      <p>Replaced a spreadsheet and four email templates. Quotes that took forty minutes now take six, and the numbers match the kiln schedule.</p>
    </article>
    <article>
      <p class="s-work__meta">Tide · 2025</p>
      <div class="s-specimen s-specimen--tide"><span>02</span></div>
      <h3>Booking for a coastal hotel</h3>
      <p>Twelve rooms, one spreadsheet, a phone that never stopped. We built the calendar the front desk actually wanted and taught it to say no politely.</p>
    </article>
    <article>
      <p class="s-work__meta">Chalk · 2025</p>
      <div class="s-specimen s-specimen--chalk"><span>03</span></div>
      <h3>An archive for a small publisher</h3>
      <p>Forty years of back catalogue, searchable in under a second, on a server that costs less per month than the coffee budget.</p>
    </article>
  </div>
</section>

<section>
  <div class="s-section__head">
    <h2>What we do</h2>
    <p>We take a product from a sentence to something a stranger can pay for, and then we keep it running. No handover to an agency, no discovery phase that produces a deck.</p>
  </div>
  <ul class="s-list">
    <li><span class="s-list__n">01</span><h3>Decide what it is</h3><p>Two weeks, a working prototype and a list of the things we are deliberately not building. The output is a decision, not a document.</p></li>
    <li><span class="s-list__n">02</span><h3>Design the parts people touch</h3><p>Screens, states, and the eleven places where the software has to say something honest about what just happened.</p></li>
    <li><span class="s-list__n">03</span><h3>Build it and keep it up</h3><p>Typed, tested, deployed on a Tuesday afternoon with a rollback that has been rehearsed. Then we stay.</p></li>
  </ul>
</section>

<section id="journal">
  <div class="s-section__head">
    <h2>From the journal</h2>
    <p>Notes on building software at this size. Short, occasionally wrong, always ours.</p>
  </div>
  <div class="list" data-gjs-type="list" data-source="blog/recent-posts" data-limit="3">
    <ul class="list__items">
      <li data-repeat><a data-bind-label="title" data-bind-href-link="slug" href="#">Post title</a></li>
    </ul>
    <p class="list__empty" data-empty>Nothing published yet.</p>
  </div>
  <p class="s-more"><a href="/writing">All writing</a></p>
</section>

<section id="contact">
  <div class="s-contact">
    <div>
      <h2>Tell us what you are making.</h2>
      <p>We take on four projects a year. If yours is one of them, you will hear from a person who will be on the work — not from a sales team.</p>
      <p class="s-contact__note"><b>Prefer email</b>hello@abc123.com</p>
      <p class="s-contact__note"><b>Where we are</b>Melbourne, Australia · Lisbon, Portugal</p>
    </div>
    <div data-skw-form="contact/contact" class="skw-form-marker"></div>
  </div>
</section>
`.trim();

const ABOUT = `
<section class="s-hero">
  <p class="s-eyebrow">About</p>
  <h1>Six people,<br><em>one workshop.</em></h1>
  <div class="s-hero__grid">
    <p class="s-lede">We started in 2016 with a borrowed desk and one rule: only take work we can finish. Ten years later the rule is the same, and the desk is ours.</p>
    <ul class="s-facts">
      <li><b>2016</b><span>first invoice sent</span></li>
      <li><b>4</b><span>projects a year, at most</span></li>
      <li><b>0</b><span>projects abandoned after launch</span></li>
    </ul>
  </div>
</section>

<section>
  <div class="s-prose">
    <h2>How we work</h2>
    <p>Every project starts with a question we ask out loud: what would make this a waste of your money? The answer is usually more specific than the brief, and it is where the design starts.</p>
    <p>We build in weeks, not quarters. A prototype on day ten is worth more than a specification on day forty, because it can be used, argued with and thrown away. The first version is allowed to be ugly; it is not allowed to be dishonest.</p>
    <p>After launch we stay. Roughly half of our time is maintenance of things we built, which is why we write code as if we will be the ones reading it in three years — because we will be.</p>
    <ul class="s-principles">
      <li><b>Boring on purpose</b><span>The database is a database. The queue is a table. Novelty is a cost, and the invoice goes to the client.</span></li>
      <li><b>Say the true thing</b><span>If a feature will take three weeks, the estimate says three weeks. If we were wrong, we say that too, early.</span></li>
      <li><b>Small surface</b><span>Every screen, endpoint and setting is something that has to be maintained forever. We add them the way you add rooms to a house.</span></li>
      <li><b>Leave it running</b><span>A launch is the middle of the job. Backups, alerts and a rollback that has been rehearsed are part of the deliverable.</span></li>
    </ul>
  </div>
  <div class="s-aside">
    <h3>Elsewhere on this site</h3>
    <div class="list" data-gjs-type="list" data-source="menu/menu-main" data-limit="20">
      <ul class="list__items">
        <li data-repeat><a data-bind-label="label" data-bind-href-link="href" href="#">Item</a></li>
      </ul>
      <p class="list__empty" data-empty>Nothing here yet.</p>
    </div>
  </div>
</section>

<section>
  <div class="s-contact">
    <div>
      <h2>Work with us.</h2>
      <p>We take on four projects a year and we are picky about which four. Tell us what you are making and we will tell you honestly whether we are the right studio for it.</p>
    </div>
    <div data-skw-form="contact/contact" class="skw-form-marker"></div>
  </div>
</section>
`.trim();

const PRICING = `
<section class="s-hero">
  <p class="s-eyebrow">Pricing</p>
  <h1>Three ways<br><em>to work together.</em></h1>
  <div class="s-hero__grid">
    <p class="s-lede">Prices are fixed before we start and they include the boring parts — testing, deployment, documentation and the first month of support. No hourly billing, no change-order theatre.</p>
    <ul class="s-facts">
      <li><b>2 wk</b><span>shortest engagement we take</span></li>
      <li><b>4</b><span>projects a year, at most</span></li>
      <li><b>30 d</b><span>notice on the retainer, either way</span></li>
    </ul>
  </div>
</section>

<section>
  <div class="s-section__head">
    <h2>Engagements</h2>
    <p>Pick the shape that matches the size of the question. If none of them fit, say so — we have written custom engagements before and we will again.</p>
  </div>
  <div class="s-tiers">
    <article class="s-tier">
      <h3>Sprint</h3>
      <p class="s-tier__price">€6,000<small>two weeks, fixed</small></p>
      <ul>
        <li>A working prototype you can click</li>
        <li>One decision, documented</li>
        <li>The code, licensed to you</li>
      </ul>
      <p><a class="s-btn s-btn--quiet" href="/contact">Enquire</a></p>
    </article>
    <article class="s-tier s-tier--featured">
      <h3>Build</h3>
      <p class="s-tier__price">€18,000<small>six weeks, fixed</small></p>
      <ul>
        <li>Design and engineering, one team</li>
        <li>Deployed, tested, documented</li>
        <li>Thirty days of support included</li>
        <li>Weekly demo, no status decks</li>
      </ul>
      <p><a class="s-btn s-btn--primary" href="/contact">Start a build</a></p>
    </article>
    <article class="s-tier">
      <h3>Retainer</h3>
      <p class="s-tier__price">€4,500<small>per month</small></p>
      <ul>
        <li>Two days a week, every week</li>
        <li>Maintenance, improvements, advice</li>
        <li>First refusal on our calendar</li>
      </ul>
      <p><a class="s-btn s-btn--quiet" href="/contact">Enquire</a></p>
    </article>
  </div>
  <p class="s-more"><a href="/contact">Ask a question instead</a></p>
</section>

<section>
  <div class="s-section__head">
    <h2>What is always included</h2>
    <p>These are not upsells. A build that does not have them is not finished, so they are in every engagement, including the two-week sprint.</p>
  </div>
  <ul class="s-list">
    <li><span class="s-list__n">01</span><h3>Tests that run on every change</h3><p>The suite is the reason we can deploy on a Tuesday and sleep on a Tuesday night.</p></li>
    <li><span class="s-list__n">02</span><h3>Backups you have watched restore</h3><p>A backup nobody has restored is a rumour. We rehearse it once before launch and write down how long it took.</p></li>
    <li><span class="s-list__n">03</span><h3>An owner's manual</h3><p>Two pages: how to deploy, how to roll back, who to call. Written for the person who joins after us.</p></li>
  </ul>
</section>
`.trim();

const WRITING = `
<section class="s-hero">
  <p class="s-eyebrow">Journal</p>
  <h1>Notes from<br><em>the workshop.</em></h1>
  <div class="s-hero__grid">
    <p class="s-lede">What we learned building other people's software, written down while it is still fresh enough to be useful. No growth advice, no prediction posts.</p>
    <ul class="s-facts">
      <li><b>3</b><span>entries so far</span></li>
      <li><b>~6 min</b><span>average read</span></li>
      <li><b>1</b><span>rule: only what we did</span></li>
    </ul>
  </div>
</section>

<section>
  <div class="list" data-gjs-type="list" data-source="blog/recent-posts" data-limit="20">
    <ul class="list__items">
      <li data-repeat><a data-bind-label="title" data-bind-href-link="slug" href="#">Post title</a></li>
    </ul>
    <p class="list__empty" data-empty>Nothing published yet.</p>
  </div>
</section>
`.trim();

const CONTACT = `
<section class="s-hero">
  <p class="s-eyebrow">Contact</p>
  <h1>Tell us what<br><em>you are making.</em></h1>
  <div class="s-hero__grid">
    <p class="s-lede">One form, read by a person. If your project is a fit we will reply within two working days with a time to talk; if it is not, we will say that instead of going quiet.</p>
    <ul class="s-facts">
      <li><b>2 d</b><span>typical reply time</span></li>
      <li><b>4</b><span>projects a year</span></li>
      <li><b>6</b><span>people you might meet</span></li>
    </ul>
  </div>
</section>

<section>
  <div class="s-contact">
    <div>
      <h2>The short version.</h2>
      <p>Who you are, what you are making, and what has to be true for it to be worth doing. Three sentences is plenty. If you have a deadline, say it.</p>
      <p class="s-contact__note"><b>Email</b>hello@abc123.com</p>
      <p class="s-contact__note"><b>Studios</b>Melbourne · Lisbon</p>
      <p class="s-contact__note"><b>Not a fit</b>We do not build gambling products, ad-tech, or anything that needs a growth-hacking plan to make the numbers work.</p>
    </div>
    <div data-skw-form="contact/contact" class="skw-form-marker"></div>
  </div>
</section>
`.trim();

interface SeededPage {
  path: string;
  slug: string;
  title: string;
  body: string;
}

const PAGES: SeededPage[] = [
  { path: '/', slug: 'home', title: 'ABC 123 — small things, made properly', body: HOME },
  { path: '/about', slug: 'about', title: 'About — ABC 123', body: ABOUT },
  { path: '/pricing', slug: 'pricing', title: 'Pricing — ABC 123', body: PRICING },
  { path: '/writing', slug: 'writing', title: 'Journal — ABC 123', body: WRITING },
  { path: '/contact', slug: 'contact', title: 'Contact — ABC 123', body: CONTACT },
];

/* ------------------------------------------------------------------ the journal */

interface SeededPost {
  title: string;
  slug: string;
  body: string;
  published: string;
}

const POSTS: SeededPost[] = [
  {
    title: 'The cost of a clever abstraction',
    slug: 'cost-of-a-clever-abstraction',
    published: '2026-09-18',
    body: [
      'We spent a week in August building an abstraction over three nearly-identical forms. It was elegant: one component, one schema, three call sites. It saved about forty lines and cost a week.',
      'The forms were not identical. Two of them had a field whose label changed depending on who was filling it in, and one had to submit to a different endpoint when the record was a draft. Neither difference was visible until the abstraction existed and both of them had to be argued with.',
      'The lesson is not that abstractions are bad. It is that three copies of a form are cheap to read and expensive to keep in sync only if the form keeps changing — and these did not. We measured the change rate after the fact: eleven commits across eighteen months, nine of them to one form. Duplication would have been fine. We would have known that if we had looked before we started.',
    ].join('\n\n'),
  },
  {
    title: 'Shipping on Thursdays',
    slug: 'shipping-on-thursdays',
    published: '2026-08-02',
    body: [
      'For a year we did not deploy on Fridays. It was a rule inherited from somewhere, and like most inherited rules it was right for a reason nobody remembered: our deploys were risky, so we moved the risk to a day when nobody had to watch it.',
      'The fix was not a quieter day. It was a deploy that takes four minutes, runs its own checks, and rolls back with one command that we had used in anger. Once that was true, the day stopped mattering. We now ship on Thursdays because that is when the work is ready, and sometimes on Fridays because it is ready then too.',
      'If a process needs a rule to protect it, the process is the thing to fix. The rule is a symptom that has been given a calendar slot.',
    ].join('\n\n'),
  },
  {
    title: 'A note on type at small sizes',
    slug: 'type-at-small-sizes',
    published: '2026-06-11',
    body: [
      'Most of the interfaces we build are read at fourteen pixels, by people who are tired. That is the real design constraint, and it is not the one you see in the mockup, which is rendered at a comfortable size on a large screen by someone who has already read the copy.',
      'Two changes did more for legibility than any font choice: raising the line-height of body text to 1.65 and stopping the habit of setting secondary text below 13px. The second one costs vertical space, which is why it is unpopular, and it is the one readers notice when it is missing.',
      'We now test every screen at 100% zoom on a five-year-old laptop before it ships. If it reads there, it reads everywhere. If it only reads on the designer\'s monitor, it does not read.',
    ].join('\n\n'),
  },
];

/* ------------------------------------------------------------------ the menus */

const HEADER_NAV = [
  { label: 'About', href: '/about' },
  { label: 'Writing', href: '/writing' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Contact', href: '/contact' },
];

const FOOTER_NAV = [
  { label: 'About', href: '/about' },
  { label: 'Writing', href: '/writing' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Contact', href: '/contact' },
];

/** The rows the menu package's block draws on `/about`: the same five pages, by label. */
const MENU_ITEMS = [
  { label: 'Home', href: '/' },
  { label: 'About the studio', href: '/about' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Journal', href: '/writing' },
  { label: 'Contact', href: '/contact' },
];

const SITE_TITLE = 'ABC 123';
const FOOTER_TEXT = '© 2026 ABC 123 — a studio for small, well-made software. Melbourne & Lisbon.';

/* ------------------------------------------------------------------ writing it */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : (process.argv[index + 1] as string);
}

const dataDir = arg('data', 'data');
const tenant = arg('tenant', 'abc123');
const siteDb = join(dataDir, 'tenants', tenant, 'site.db');
if (!existsSync(siteDb)) {
  process.stderr.write(`no tenant database at ${siteDb}\n`);
  process.exit(1);
}

const db = new Database(siteDb);
db.pragma('busy_timeout = 5000');
const now = new Date().toISOString();

/**
 * `value_json` is the JSON encoding of the value, not the value itself: a `bool` row holds
 * `true`, and a row holding the string `"true"` is refused by `loadChrome` by name — which is
 * exactly how this function's first version took the whole site down with a 500.
 */
function setting(key: string, value: string | boolean, type: 'string' | 'bool'): void {
  db.prepare(
    `INSERT INTO cms_settings (key, value_json, type, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, type = excluded.type, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), type, now);
}

const write = db.transaction(() => {
  setting('site.title', SITE_TITLE, 'string');
  setting('site.footer_text', FOOTER_TEXT, 'string');
  setting('site.theme_css', THEME_CSS, 'string');
  setting('site.header_sticky', true, 'bool');
  setting('site.footer_sticky', false, 'bool');

  const upsertPage = db.prepare(
    `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, managed_by, published_at, updated_at)
     VALUES (?, ?, ?, 'published', 'page', ?, '', 1, ?, 'editor', ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       slug = excluded.slug, title = excluded.title, status = 'published',
       body_html = excluded.body_html, body_css = excluded.body_css,
       rev = cms_page.rev + 1, body_sha = excluded.body_sha,
       published_at = excluded.published_at, updated_at = excluded.updated_at,
       draft_html = '', draft_css = '', draft_sha = ''`,
  );
  for (const page of PAGES) upsertPage.run(page.path, page.slug, page.title, page.body, SHA(page.body), now, now);

  // A menu is rows, and `ux_nav_pos` is UNIQUE on (location, parent, position): clearing and
  // re-inserting in one transaction is the only way to rewrite it without a swap dance.
  db.prepare(`DELETE FROM cms_nav`).run();
  const addNav = db.prepare(
    `INSERT INTO cms_nav (location, label, href_kind, href_target, position, visible) VALUES (?, ?, 'page', ?, ?, 1)`,
  );
  HEADER_NAV.forEach((item, index) => addNav.run('header', item.label, item.href, index));
  FOOTER_NAV.forEach((item, index) => addNav.run('footer', item.label, item.href, index));

  // The blog package's table: three published posts, so its block and its detail pages have
  // something real to draw. `status='published'` is what the page declaration filters on.
  db.prepare(`DELETE FROM p_blog_post`).run();
  const addPost = db.prepare(
    `INSERT INTO p_blog_post (title, slug, body, status, published_at, created_at) VALUES (?, ?, ?, 'published', ?, ?)`,
  );
  for (const post of POSTS) addPost.run(post.title, post.slug, post.body, `${post.published}T09:00:00.000Z`, now);

  // The menu package's table.
  db.prepare(`DELETE FROM p_menu_item`).run();
  const addMenuItem = db.prepare(
    `INSERT INTO p_menu_item (menu, label, href, position, visible, created_at) VALUES ('main', ?, ?, ?, 1, ?)`,
  );
  MENU_ITEMS.forEach((item, index) => addMenuItem.run(item.label, item.href, index + 1, now));
});

write();

const pageCount = (db.prepare(`SELECT COUNT(*) AS n FROM cms_page WHERE status = 'published'`).get() as { n: number }).n;
const postCount = (db.prepare(`SELECT COUNT(*) AS n FROM p_blog_post WHERE status = 'published'`).get() as { n: number }).n;
const navCount = (db.prepare(`SELECT COUNT(*) AS n FROM cms_nav`).get() as { n: number }).n;
db.close();

process.stdout.write(
  `seeded ${tenant}: ${String(pageCount)} published pages, ${String(postCount)} posts, ${String(navCount)} menu rows, theme ${String(THEME_CSS.length)} bytes\n` +
    PAGES.map((page) => `  ${page.path.padEnd(10)} ${page.title}\n`).join(''),
);
