/**
 * The shell: one document, one inline <style>, no external request.
 *
 * Direction 03 (Guided Cards) is a *posture*, and the posture is carried by the shell:
 * a white app bar, a soft canvas, 14 px cards, one primary action per screen, and a
 * system font stack. There is no build step and no stylesheet to fetch, so the style
 * block below IS the design token file — every screen this admin renders shares it,
 * including the ones phase 2 has not restyled yet (they get the shell and keep their
 * own body markup).
 *
 * Accessibility that lives here rather than per-screen:
 *   - a skip link, first in the tab order, to `#main`;
 *   - `:focus-visible` rings on every control, including the dark selected pill;
 *   - `.sr-only`, so a label can be present without being drawn;
 *   - a nav whose current item is `aria-current="page"` (not colour alone).
 */
import { esc } from './html.ts';
import { ADMIN_ROBOTS_META } from '../../render/robots.ts';

export type NavKey = 'pages' | 'site' | 'themes' | 'media' | 'plugins' | 'none';

export interface NavItem {
  href: string;
  label: string;
}

export interface ShellUser {
  email: string;
  role: string;
}

export interface LayoutInput {
  /** The document title. The design writes "Skunkworks" last, tenant first. */
  title: string;
  /** Everything between `<main>` and `</main>`. */
  body: string;
  /** `null` for the fleet console and for anything with no tenant. */
  tenant?: { key: string; label: string } | null;
  user?: ShellUser | null;
  /** Which app-bar item is the page you are on. */
  active?: NavKey;
  /** Extra app-bar items (core's Tables / Data sources / Session, and plugin menus). */
  nav?: NavItem[];
  /** Count shown beside "Plugins" — the notices an operator has not seen. */
  notices?: number;
  /**
   * `app` draws the bar and the page gutter; `plain` draws only the canvas and
   * `<main>`, which is what the centered sign-in card needs.
   */
  chrome?: 'app' | 'plain';
  /** A short line under the page, for the operator: tenant, mode, build. */
  colophon?: string;
  /**
   * What the last action did, and whether it worked.
   *
   * This is a prop and not a screen's own markup because a screen that posts and redirects has
   * nowhere else to put it: `POST /themes/upload` answers `303 …?result=uploaded`, the GET renders a
   * fresh page, and any state the POST held is gone. Twice now a screen has computed a message,
   * passed it into this function, and had it silently dropped (the Themes screen, S8x) — so the
   * message is part of the layout's contract, rendered above the page's own content, instead of a
   * string each screen has to remember to draw.
   */
  flash?: { text: string; kind: 'ok' | 'bad' };
}

/**
 * The design's tokens, then its components in the order the screens use them.
 *
 * Sizes are the README's: base 15/1.55, card padding 22, row padding 15/18, radii
 * 8/10/14/20/999, page gutter 28, page width 1060.
 */
const CSS = `
:root{
  --canvas:#eef2f8; --card:#ffffff; --card-2:#f7f9fd;
  --ink:#182130; --ink-2:#3f4b5e; --muted:#66748a; --faint:#93a0b3;
  --line:#e2e8f1; --line-2:#d3dce9;
  --blue:#2563eb; --blue-2:#1d4ed8; --blue-soft:#e8f0ff; --blue-line:#c7d9ff;
  --green:#0f9d6e; --green-soft:#e7f7f1; --green-ink:#0b7a55; --green-line:#c6ebdc;
  --amber:#b45309; --amber-soft:#fff5e6; --amber-ink:#8a4a09; --amber-line:#f3d7ac;
  --red:#d33a3a; --red-soft:#fdeeee; --red-line:#f3cccc;
  --r-sm:8px; --r-in:10px; --r:14px; --r-lg:20px;
  --shadow:0 1px 2px rgba(24,33,48,.05),0 12px 32px rgba(24,33,48,.07);
  --shadow-sm:0 1px 2px rgba(24,33,48,.06),0 2px 8px rgba(24,33,48,.04);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
a{color:var(--blue-2);text-decoration:none}
a:hover{text-decoration:underline}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
figure{margin:0}
code{font-family:var(--mono)}
::selection{background:#d7e4ff}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:4px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip{position:absolute;left:12px;top:-48px;z-index:60;background:var(--ink);color:#fff;font-size:13px;font-weight:600;padding:10px 14px;border-radius:10px}
.skip:focus{top:12px}

/* app bar */
.appbar{display:flex;align-items:center;gap:20px;min-height:66px;padding:10px 28px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px}
.brand__mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(145deg,#3b82f6,#1d4ed8);color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px;box-shadow:0 4px 10px rgba(37,99,235,.28)}
.brand b{font-size:15px;font-weight:650;letter-spacing:-.01em}
.tenantpill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2);background:var(--card-2);border:1px solid var(--line);padding:5px 9px;border-radius:999px}
.tenantpill i{width:6px;height:6px;border-radius:50%;background:var(--green);display:block}
.appnav{display:flex;gap:2px;flex-wrap:wrap}
.appnav a{padding:8px 13px;border-radius:9px;font-size:13.5px;color:var(--muted)}
.appnav a:hover{background:var(--card-2);color:var(--ink);text-decoration:none}
.appnav a[aria-current="page"]{background:var(--blue-soft);color:var(--blue-2);font-weight:600}
.appbar__right{margin-left:auto;display:flex;align-items:center;gap:14px}
.avatar{width:32px;height:32px;border-radius:50%;background:#dfe8f7;color:#2c4a7c;display:grid;place-items:center;font-size:11px;font-weight:650}
.who{font-size:12px;line-height:1.35;color:var(--muted)}
.who b{display:block;color:var(--ink);font-weight:600;font-size:12.5px}

/* A cell that holds two POST forms (a plugin's Disable and Uninstall) lays them side by side
   rather than stacking two wide buttons down a table column. */
td form{display:inline-block;margin:0 6px 4px 0}
td form button{min-height:32px;padding:0 12px;border-radius:var(--r-sm);border:1px solid var(--line-2);background:#fff;color:var(--ink-2);font:600 12.5px/1 var(--sans);cursor:pointer}
td form button:hover{border-color:var(--blue);color:var(--blue-2)}
td form[action$="/disable"] button,td form[action$="/uninstall"] button{border-color:var(--red-line);color:#a02a2a;background:var(--red-soft)}

/* page frame */
.page{max-width:1060px;margin:0 auto;padding:34px 28px 80px}
.pagehead{display:flex;align-items:flex-start;gap:20px;margin-bottom:22px;flex-wrap:wrap}
.pagehead h1{margin:0 0 4px;font-size:30px;line-height:1.2;letter-spacing:-.025em;font-weight:650}
.pagehead p{margin:0;color:var(--muted);font-size:14px;max-width:62ch}
.pagehead .actions{margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 15px;border-radius:var(--r-in);font-size:13.5px;font-weight:600;border:1px solid var(--line-2);background:#fff;color:var(--ink-2);box-shadow:var(--shadow-sm);white-space:nowrap;cursor:pointer}
.btn:hover{border-color:#b9c6d8;color:var(--ink);text-decoration:none}
.btn--primary{background:var(--blue);border-color:var(--blue);color:#fff;box-shadow:0 4px 12px rgba(37,99,235,.22)}
.btn--primary:hover{background:var(--blue-2);border-color:var(--blue-2);color:#fff}
.btn--sm{min-height:32px;padding:0 11px;font-size:12.5px;border-radius:var(--r-sm)}
.btn--danger{color:#a02a2a;border-color:var(--red-line);background:var(--red-soft)}
.btn--danger:hover{border-color:#e4a9a9;color:#7d1f1f}
.btn .ic{width:16px;height:16px;flex:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow-sm)}
/* A card that carries prose and a table rather than one row per line of text: the padding is
   the card's, not the content's, so a heading and a table share the same left edge. */
.card--padded{padding:22px 22px 18px;margin:0 0 16px}
.card--padded>h2{margin:0 0 4px;font-size:19px;font-weight:650;letter-spacing:-.014em;line-height:1.3}
.card--padded>p{margin:0 0 16px;color:var(--muted);font-size:13.5px;max-width:72ch;line-height:1.55}
.card--padded .hint{margin:12px 0 0;font-size:12.5px;color:var(--muted);line-height:1.5}
.card--padded .hint code{font-size:11.5px}
.card--padded table{margin:4px 0 12px}
.card--padded th:first-child,.card--padded td:first-child{padding-left:0}
.card--padded th:last-child,.card--padded td:last-child{padding-right:0}
/* S8s: a row of actions in a table cell. The legacy form is a two-column property sheet, so a form
   here has to be inline and the cell has to lay its buttons out itself. */
.card--padded td.rowey{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.card--padded td.rowey form{margin:0;display:inline-block}
.sectionhead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:26px 2px 10px;flex-wrap:wrap}
.sectionhead h2{margin:0;font-size:13px;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);font-weight:650}
.sectionhead span{font-size:12px;color:var(--faint)}

/* next-step banner */
.nextstep{display:flex;align-items:center;gap:16px;background:linear-gradient(120deg,#fff8ec,#fffdf8);border:1px solid var(--amber-line);border-radius:var(--r);padding:16px 18px;margin-bottom:22px;flex-wrap:wrap}
.nextstep--calm{background:linear-gradient(120deg,#f2fbf7,#fbfffd);border-color:var(--green-line)}
.nextstep__icon{width:38px;height:38px;border-radius:10px;background:#fff;border:1px solid var(--amber-line);display:grid;place-items:center;color:var(--amber);flex:none}
.nextstep--calm .nextstep__icon{border-color:var(--green-line);color:var(--green-ink)}
.nextstep b{display:block;font-size:14px;margin-bottom:1px}
.nextstep p{margin:0;font-size:13px;color:#7a5a32;max-width:62ch}
.nextstep--calm p{color:#2c6b56}
.nextstep .btn{margin-left:auto}

/* page rows */
.pagelist{overflow:hidden}
.pagerow{display:flex;align-items:center;gap:16px;padding:15px 18px;border-bottom:1px solid var(--line)}
.pagerow:last-child{border-bottom:0}
.pagerow:hover{background:#fafcff}
.thumb-ic{width:44px;height:44px;border-radius:11px;flex:none;display:grid;place-items:center;color:#fff;font-size:15px;font-weight:700;letter-spacing:.02em;box-shadow:inset 0 0 0 1px rgba(0,0,0,.04)}
.thumb-ic.a{background:linear-gradient(145deg,#4f7cff,#2f4fd8)}
.thumb-ic.b{background:linear-gradient(145deg,#e7a06a,#b96b3f)}
.thumb-ic.c{background:linear-gradient(145deg,#69b7a1,#2f7f6b)}
.pagerow__main{min-width:0;flex:1}
.pagerow__title{font-size:16px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pagerow__meta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-top:2px;flex-wrap:wrap}
.pagerow__noindex{color:#8a4a09;font-weight:600}
.pagerow__search{display:flex;align-items:center;gap:6px;flex:none}
.pagerow__search select{min-height:30px;border:1px solid var(--line-2);border-radius:var(--r-sm);padding:0 6px;font:12.5px/1.3 var(--sans);color:var(--ink);background:#fff}
.pagerow__search select:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,.12);outline:0}
.dotsep{width:3px;height:3px;border-radius:50%;background:#c3cdda;display:inline-block}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:4px 9px;border-radius:999px;white-space:nowrap}
.pill i{width:5px;height:5px;border-radius:50%;background:currentColor;display:block;flex:none}
.pill--live{background:var(--green-soft);color:var(--green-ink)}
.pill--draft{background:var(--amber-soft);color:var(--amber-ink)}
.pill--private{background:#f3f5fa;color:#51607a}
.pill--lock{background:var(--amber-soft);color:var(--amber-ink)}
.rowactions{display:flex;align-items:center;gap:6px;margin-left:4px}
.chev{color:#a9b5c6;font-size:18px;line-height:1;padding:0 2px}

/* stats */
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:20px 0 0;padding:0}
.stat{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:15px 17px;box-shadow:var(--shadow-sm);display:flex;flex-direction:column-reverse;gap:1px}
.stat dt{font-size:12px;color:var(--muted)}
.stat dd{margin:0;font-size:24px;line-height:1.1;letter-spacing:-.02em;font-weight:650}
.helper{display:flex;gap:10px;align-items:flex-start;margin-top:20px;padding:14px 16px;background:var(--card-2);border:1px solid var(--line);border-radius:var(--r);font-size:13px;color:var(--ink-2);line-height:1.55}
.helper .ic{color:var(--blue);flex:none;margin-top:2px}
.helper b{font-weight:600}

/* media library */
.notepanel{display:flex;align-items:center;gap:16px;border:1.5px dashed #b9c9df;background:linear-gradient(180deg,#fbfdff,#f6f9fe);border-radius:var(--r);padding:18px 20px;margin-bottom:20px;flex-wrap:wrap}
.notepanel__icon{width:42px;height:42px;border-radius:12px;background:#fff;border:1px solid var(--line);display:grid;place-items:center;color:var(--blue);flex:none;box-shadow:var(--shadow-sm)}
.notepanel b{display:block;font-size:14.5px}
.notepanel p{margin:2px 0 0;font-size:12.5px;color:var(--muted);max-width:60ch}
.toolbar{display:flex;align-items:center;gap:10px;margin:4px 0 16px;flex-wrap:wrap}
.chips{display:flex;gap:6px;margin-right:auto;flex-wrap:wrap}
.chip{font-size:12.5px;padding:7px 12px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--muted)}
.chip:hover{border-color:#becbdb;color:var(--ink);text-decoration:none}
.chip[aria-current="page"]{background:var(--ink);border-color:var(--ink);color:#fff}
.search{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line-2);border-radius:var(--r-in);padding:0 8px 0 11px;min-height:36px;min-width:330px;color:var(--faint)}
.search input{border:0;outline:0;background:none;font:13px/1.4 var(--sans);color:var(--ink);width:100%;padding:8px 0}
.search input::placeholder{color:var(--faint)}
.search .btn{box-shadow:none;border-color:transparent;background:var(--card-2);color:var(--ink-2);min-height:26px;padding:0 9px;font-size:12px}
.mediagrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.asset{background:#fff;border:1px solid var(--line);border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow-sm);display:flex;flex-direction:column}
.asset:hover{box-shadow:var(--shadow)}
.asset__frame{position:relative;aspect-ratio:4/3;background:#e9eef6;border-bottom:1px solid var(--line);overflow:hidden}
.asset__frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.kind{position:absolute;left:10px;top:10px;z-index:3;font-size:10.5px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:#41506a;background:rgba(255,255,255,.92);border:1px solid rgba(24,33,48,.08);border-radius:6px;padding:3px 6px}
.kind.lock{color:var(--amber-ink);background:#fff7ea;border-color:#f0d8b2}
.nothumb{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#6b7a90;font-size:12px;background:linear-gradient(160deg,#eef2f8,#e3e9f2)}
.nothumb svg{color:#8b9ab0}
.asset__body{padding:11px 13px 12px;display:flex;flex-direction:column;flex:1}
.asset__name{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.asset__meta{font-size:11.5px;color:var(--muted);margin-top:1px}
.asset__use{display:flex;align-items:center;gap:6px;margin-top:9px;padding:5px 8px;background:var(--card-2);border:1px solid var(--line);border-radius:var(--r-sm);font-size:11.5px;color:var(--ink-2);line-height:1.35}
.asset__use b{font-weight:650;color:var(--ink)}
.asset__use svg{color:var(--faint);flex:none}
.asset__use.is-unused{background:var(--green-soft);border-color:var(--green-line);color:var(--green-ink)}
.asset__use.is-unused b{color:var(--green-ink)}
.asset__use.is-unused svg{color:var(--green-ink)}
.asset__use.is-gated{background:var(--amber-soft);border-color:var(--amber-line);color:var(--amber-ink)}
.asset__use.is-gated b{color:var(--amber-ink)}
.asset__use.is-gated svg{color:#b5762c}
.asset__foot{display:flex;align-items:center;gap:8px;padding-top:10px}
.asset__foot .pill{font-size:10.5px;padding:3px 7px}
.asset__foot form{margin:0 0 0 auto}
.asset__foot .btn{margin-left:auto}
.asset__blocked{margin-left:auto;font-size:11px;color:var(--faint);text-align:right;line-height:1.3;max-width:15ch}
.picked{margin:0 0 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.picked label{font-size:12.5px;font-weight:600}
.picked input{min-height:36px;border:1px solid var(--line-2);border-radius:var(--r-sm);padding:0 10px;font:13px/1 var(--mono);color:var(--ink);background:var(--card-2)}
.morelist{overflow:hidden;display:flex;flex-direction:column}
.morelink{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);font-size:13.5px;color:var(--ink-2)}
.morelink:last-child{border-bottom:0}
.morelink:hover{background:#fafcff;text-decoration:none;color:var(--ink)}
.asset__note{margin-top:8px;font-size:11.5px;color:var(--amber-ink);background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:var(--r-sm);padding:6px 8px;line-height:1.45}
.asset--gated{border:1.5px dashed var(--amber-line);background:#fffaf1;box-shadow:none}
.asset--gated:hover{box-shadow:0 8px 20px rgba(180,83,9,.12);border-color:#e6c38f}
.asset__frame--gated{background:repeating-linear-gradient(135deg,#fdf3e2 0 9px,#f9ecd8 9px 18px);border-bottom:1px dashed var(--amber-line);display:grid;place-items:center}
.locked{display:flex;flex-direction:column;align-items:center;gap:9px;text-align:center;padding:12px;position:relative;z-index:2}
.locked__ring{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;color:var(--amber-ink);background:#fff;border:1.5px solid var(--amber-line);box-shadow:0 6px 14px rgba(180,83,9,.14)}
.locked__word{font-size:11px;font-weight:650;letter-spacing:.04em;color:var(--amber-ink);background:#fff;border:1px solid var(--amber-line);border-radius:999px;padding:5px 10px;white-space:nowrap}
.locked__sub{font-size:11.5px;color:#9a6a30;max-width:26ch;line-height:1.4}
.empty{padding:26px;text-align:center;color:var(--muted);font-size:14px}

/* sign in */
.signin{min-height:100vh;display:grid;place-items:center;padding:40px 20px;background:radial-gradient(1200px 600px at 50% -10%,#e3ecff,#eef2f8 60%)}
.signin__wrap{width:420px;max-width:100%}
.signin__brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:22px}
.signin__brand b{font-size:16px;font-weight:650}
.signin__card{background:#fff;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:0 2px 4px rgba(24,33,48,.04),0 28px 70px rgba(24,33,48,.13);padding:30px}
.signin__card h1{margin:0 0 4px;font-size:25px;letter-spacing:-.025em}
.signin__card .sub{margin:0 0 18px;font-size:13.5px;color:var(--muted)}
.stepdots{display:flex;gap:5px;margin:0 0 20px}
.stepdots i{height:4px;border-radius:2px;background:var(--line-2);flex:1}
.stepdots i.on{background:var(--blue)}
.sf{margin-bottom:14px}
.sf label{display:block;font-size:12.5px;font-weight:600;margin-bottom:5px}
.sf input{width:100%;min-height:42px;border:1px solid var(--line-2);border-radius:var(--r-in);padding:0 12px;font:14px/1.4 var(--sans);color:var(--ink);background:#fff;outline:0}
.sf input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.sf input[name="totp"]{letter-spacing:.36em;font-family:var(--mono);font-size:16px}
.sf select{width:100%;min-height:42px;border:1px solid var(--line-2);border-radius:var(--r-in);padding:0 10px;font:14px/1.4 var(--sans);color:var(--ink);background:#fff}
.sf select:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,.12);outline:0}
.sf input[type="file"]{padding:9px 12px;min-height:42px;background:var(--card-2);cursor:pointer}
/* the upload card: a form, not a note that apologises for not being one */
.upload{padding:20px 20px 16px;margin:0 0 18px}
.upload h2{margin:0 0 4px;font-size:16px;font-weight:650;letter-spacing:-.01em}
.upload__lede{margin:0 0 14px;font-size:13px;color:var(--muted);max-width:62ch}
.upload form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;align-items:start}
.upload form .sf:nth-child(2){grid-column:1}
.upload form button{grid-column:1/-1;justify-self:start;margin-top:4px}
.sf .help{font-size:11.5px;color:var(--muted);margin:5px 0 0;line-height:1.45}
.signin__card .submit{width:100%;min-height:44px;border-radius:var(--r-in);background:var(--blue);color:#fff;font-size:14px;font-weight:650;margin-top:4px;box-shadow:0 6px 16px rgba(37,99,235,.24);border:0}
.signin__card .submit:hover{background:var(--blue-2)}
.signin__after{margin:14px 0 0;text-align:center;font-size:12px;color:var(--muted);line-height:1.5}
/* S8g: a package's declared form. One field per block — label, control, help — because the
   property-sheet grid pairs a label with whatever cell comes next, and a help line is a cell. */
.legacy form.fields{display:block;max-width:760px}
.legacy form.fields .field{margin:0 0 20px}
.legacy form.fields .field label{display:block;margin:0 0 6px;font-weight:600;color:inherit}
.legacy form.fields .field input,.legacy form.fields .field select{width:100%;max-width:520px}
.legacy form.fields .field textarea{width:100%;font:inherit;line-height:1.55}
.legacy form.fields .field .help{margin:6px 0 0;color:var(--muted);font-size:12.5px;line-height:1.45}
/* S8i: the sub-menu under Plugins — one group per loaded package, its screens beneath it. */
.subnav{margin:0 0 18px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r);background:var(--card)}
.subnav ul{list-style:none;margin:0;padding:0}
.subnav>ul>li{margin:0 0 8px}
.subnav__group{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.subnav>ul>li>ul{margin:2px 0 0;padding-left:0}
.subnav a{font-size:14px}
.subnav__empty{margin:0 0 18px;color:var(--muted);font-size:13px}
/* S8f: one sentence from a failed attempt, above the form it belongs to. */
.signin__error{margin:0 0 16px;padding:10px 12px;border:1px solid #f0c2bd;border-radius:var(--r-in);background:#fdf3f2;color:#8f2b21;font-size:13px;line-height:1.45}
.signin__foot{text-align:center;font-size:11.5px;color:var(--muted);margin-top:18px;line-height:1.6}

/* a page that has not been restyled keeps the old body markup; give it room */
.legacy{font-size:14px}
/* S8d: the trail out of the table screens. Ordered-list semantics, the separators hidden from
   assistive tech, and the current page marked by aria-current rather than by colour. */
.crumbs{margin:0 0 14px}
.crumbs ol{list-style:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0;padding:0;font-size:13px}
.crumbs li{display:flex;align-items:center;gap:6px}
.crumbs li.sep{color:var(--faint)}
.crumbs a{color:var(--blue-2)}
.crumbs [aria-current="page"]{color:var(--ink-2);font-weight:600}
.formback{margin:0 0 12px}
/* S8d: the generated row form. Its markup is a flat label/input sequence — one per editable
   column — so the layout is a two-column property sheet rather than a wrapper per field. */
.legacy form{display:grid;grid-template-columns:minmax(170px,230px) minmax(0,1fr);gap:10px 16px;align-items:center;max-width:920px;margin:18px 0}
.legacy form label{margin:0;font-size:12.5px;font-weight:600;color:var(--ink-2)}
.legacy form label small{display:block;font-weight:400;font-size:11px;color:var(--muted);letter-spacing:.02em}
.legacy form input,.legacy form textarea{width:100%;min-height:38px;border:1px solid var(--line-2);border-radius:var(--r-sm);padding:7px 10px;font:13px/1.45 var(--sans);background:#fff;color:var(--ink)}
.legacy form select{width:100%;min-height:38px;border:1px solid var(--line-2);border-radius:var(--r-sm);padding:7px 10px;font:13px/1.45 var(--sans);background:#fff;color:var(--ink)}
/* A checkbox is not a text field: the two-column sheet must not stretch it into a blue slab. */
.legacy form input[type="checkbox"],.legacy form input[type="radio"]{width:18px;height:18px;min-height:0;justify-self:start;margin:0;accent-color:var(--blue)}
.legacy form input:focus,.legacy form textarea:focus,.legacy form select:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,.12);outline:0}
/* Save and whatever sits beside it are one row across the sheet, not a cell in the value column. */
.legacy .formactions{grid-column:1/-1;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}
.legacy .formactions .btn{min-height:36px;padding:0 16px;font-size:13px}
.legacy form textarea{min-height:88px;font-family:var(--mono);font-size:12px}
.legacy form input[type="number"]{max-width:220px}
.legacy form button{grid-column:2;justify-self:start;min-height:36px;padding:0 16px;border-radius:var(--r-sm);border:1px solid var(--blue);background:var(--blue);color:#fff;font:600 13px/1 var(--sans);cursor:pointer}
/* A form inside a table cell is a row of small actions, not the two-column property sheet the
   .legacy form rule above describes. That rule's display:grid is what made every row's arrows,
   Hide and Delete stack down the ACTIONS column like a list of verbs. */
.legacy td form{display:inline-block;grid-template-columns:none;gap:0;max-width:none;margin:0 6px 4px 0;align-items:center}
.legacy td form button{grid-column:auto;justify-self:auto;margin:0}
.legacy form[action$="/delete"] button{border-color:var(--red-line);background:var(--red-soft);color:#a02a2a}
.legacy table{border-collapse:collapse;width:100%;margin:12px 0}
.legacy th,.legacy td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;font-size:13px;vertical-align:top}
.legacy th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.legacy ul[data-role="tables"]{list-style:none;margin:12px 0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.legacy ul[data-role="tables"] a{display:inline-block;padding:7px 12px;border:1px solid var(--line-2);border-radius:var(--r-sm);background:#fff;font-size:13px;color:var(--ink-2)}
.legacy ul[data-role="tables"] a:hover{border-color:var(--blue);color:var(--blue-2);text-decoration:none}
.colophon{margin:34px 0 0;font-size:11.5px;color:var(--faint)}

/* The plugin upload form: a file, two acknowledgements, one button.
   Scoped with .legacy because the screen's wrapper carries that class and the .legacy form rule
   is the two-column property sheet — which otherwise wins on specificity and lays this form out
   as label|control pairs, with the file field squeezed into a 230 px column. */
.legacy .uploadcard{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;max-width:720px;margin:0 0 10px;padding:18px;border:1px solid var(--line);border-radius:var(--r);background:var(--card-2);align-items:start}
/* S8x: the Themes upload card is on a designed screen, not a legacy one, so it carries its own
   rules. Without them the label, the picker and the Name field rendered as one inline run — the
   state of the form was genuinely hard to read, which is half of why "it says No file chosen"
   looked like a broken control rather than an empty one. */
.uploadcard--theme{display:grid;grid-template-columns:minmax(0,1fr);gap:11px;max-width:560px;margin:0 0 10px;padding:16px;border:1px solid var(--line);border-radius:var(--r);background:var(--card-2);align-items:start}
.uploadcard--theme>label{font-size:12.5px;font-weight:600;color:var(--ink-2);margin:0}
.uploadcard--theme input[type="file"]{display:block;margin-top:2px;font:13px/1.4 var(--sans);color:var(--ink);max-width:100%;min-height:0;padding:9px 12px;background:#fff;border:1px solid var(--line-2);border-radius:var(--r-sm);cursor:pointer}
.uploadcard--theme input[type="file"]::file-selector-button{margin:0 10px 0 0;padding:5px 11px;font:600 12.5px/1.2 var(--sans);color:var(--ink);background:var(--card);border:1px solid var(--line-2);border-radius:var(--r-sm);cursor:pointer}
.uploadcard--theme input[type="file"]::file-selector-button:hover{background:var(--card-2)}
.uploadcard--theme input:not([type]){display:block;width:100%;max-width:100%;min-height:0;padding:9px 12px;font:13px/1.4 var(--sans);color:var(--ink);background:#fff;border:1px solid var(--line-2);border-radius:var(--r-sm)}
.uploadcard--theme>button,.uploadcard--theme p{margin:0}
.uploadcard--theme[data-drag="over"]{border-color:var(--blue);background:var(--blue-soft);box-shadow:0 0 0 3px var(--blue-line)}
.uploadstate{margin:0;font-size:12.5px;line-height:1.45;color:var(--ink-2)}
.uploadstate[data-state="empty"]{color:var(--ink-2)}
.uploadstate[data-state="ready"]{color:var(--green-ink);font-weight:600}
.uploadstate[data-state="refused"]{color:var(--amber-ink);font-weight:600}
.legacy .uploadcard>label,.legacy .uploadcard>button{grid-column:1}
.legacy .uploadcard>label{font-size:12.5px;font-weight:600;color:var(--ink-2);margin:0}
.legacy .uploadcard input[type="file"]{display:block;margin-top:6px;font:13px/1.4 var(--sans);color:var(--ink);max-width:100%;min-height:0;padding:9px 12px;background:#fff;border:1px solid var(--line-2);border-radius:var(--r-sm)}
.legacy .uploadcard .ack{display:flex;gap:9px;align-items:flex-start;font-weight:400;font-size:12.5px;color:var(--ink-2);line-height:1.45}
.legacy .uploadcard .ack input{width:16px;height:16px;min-height:0;margin:1px 0 0;accent-color:var(--blue);flex:none}
/* The library's Install form sits inside a table cell: two stacked 16px checkboxes made every row
   twice as tall as its text and squeezed the button below them. Inline, they read as the two
   conditions they are, on one line, and the button stays beside them. */
.legacy td form .ack{display:inline-flex;gap:5px;align-items:center;font-size:11.5px;line-height:1.2;margin:0 10px 0 0;color:var(--ink-2);white-space:nowrap}
.legacy td form .ack input{width:13px;height:13px;min-height:0;margin:0;flex:none;accent-color:var(--blue)}
.legacy td form button{margin-left:2px}
.legacy .uploadcard>button{justify-self:start;grid-column:1}

/* account: two narrow cards side by side, the sign-out card full width under them */
.acct{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
.acct__card{padding:20px 20px 18px}
.acct__card--wide{grid-column:1/-1}
.acct__card h2{margin:0 0 4px;font-size:16px;font-weight:650;letter-spacing:-.01em}
.acct__lede{margin:0 0 14px;font-size:13px;color:var(--muted);max-width:52ch}
.acct__card form{margin:0}
.acct__flash{display:flex;gap:10px;align-items:flex-start;margin:0 0 16px;padding:12px 14px;border-radius:var(--r-in);font-size:13.5px;line-height:1.5;border:1px solid}
.acct__flash--ok{background:var(--green-soft);border-color:var(--green-line);color:var(--green-ink)}
.acct__flash--bad{background:var(--amber-soft);border-color:var(--amber-line);color:var(--amber-ink)}
.acct__flash svg{flex:none;margin-top:1px}
/* the app bar's identity block is a link now: it is the way to the account screen */
a.who:hover{text-decoration:none}
a.who:hover b{color:var(--blue-2);text-decoration:underline}
@media (max-width:1100px){.mediagrid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:720px){
  .mediagrid{grid-template-columns:minmax(0,1fr)}
  .stats{grid-template-columns:minmax(0,1fr)}
  .page{padding:22px 16px 60px}
  .appbar{padding:10px 16px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

/** The icons the three screens use. Inline, `aria-hidden`, and never load-bearing. */
export const ICON = {
  plus: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  chevron: '<span class="chev" aria-hidden="true">›</span>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  lock: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="4" y="10.5" width="16" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
  warn: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 9v4m0 4h.01"/><path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
  info: '<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>',
  page: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="13" height="16" rx="2"/><path d="M8 4h13v16H8"/></svg>',
  doc: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>',
  external: '<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
} as const;

function navOf(input: LayoutInput): string {
  if (input.chrome === 'plain' || input.tenant === undefined || input.tenant === null) return '';
  const tenant = input.tenant.key;
  const items: { key: NavKey; href: string; label: string }[] = [
    { key: 'pages', href: `/admin/t/${encodeURIComponent(tenant)}/`, label: 'Pages' },
    // S8l: the bar and footer every page wears. It sat behind `sqlite3` until this screen.
    { key: 'site', href: `/admin/t/${encodeURIComponent(tenant)}/site`, label: 'Site' },
    // S8s: the look, next to the other site-wide decisions and before the content ones.
    { key: 'themes', href: `/admin/t/${encodeURIComponent(tenant)}/themes`, label: 'Themes' },
    { key: 'media', href: `/admin/t/${encodeURIComponent(tenant)}/media`, label: 'Photos &amp; files' },
    {
      key: 'plugins',
      href: `/admin/t/${encodeURIComponent(tenant)}/plugins`,
      label: input.notices === undefined || input.notices === 0 ? 'Plugins' : `Plugins (${input.notices})`,
    },
  ];
  for (const extra of input.nav ?? []) items.push({ key: 'none', href: extra.href, label: esc(extra.label) });
  const links = items
    .map((item) => {
      const current = item.key !== 'none' && item.key === (input.active ?? 'none') ? ' aria-current="page"' : '';
      return `<a href="${esc(item.href)}"${current}>${item.label}</a>`;
    })
    .join('\n      ');
  return `\n    <nav class="appnav" aria-label="Admin sections">\n      ${links}\n    </nav>`;
}

function barOf(input: LayoutInput): string {
  if (input.chrome === 'plain') return '';
  const tenantName = input.tenant === undefined || input.tenant === null ? '' : input.tenant.label;
  const pill =
    input.tenant === undefined || input.tenant === null
      ? ''
      : `<span class="tenantpill"><i aria-hidden="true"></i>${esc(tenantName)}</span>`;
  const user = input.user;
  // The identity block is the way to the account screen: until S8a it was inert text on a
  // bar with no control that reached `logout` at all. With no tenant (the fleet console)
  // there is no `/admin/t/…/account` to point at, so it stays text there.
  const accountHref =
    input.tenant === undefined || input.tenant === null || user === undefined || user === null
      ? null
      : `/admin/t/${encodeURIComponent(input.tenant.key)}/account`;
  const who =
    user === undefined || user === null
      ? ''
      : `${accountHref === null ? '' : `<a class="who" href="${esc(accountHref)}" title="Your account">`}
      <span class="avatar" aria-hidden="true">${esc(initials(user.email))}</span>
      <span class="who"><b>${esc(user.role === 'owner' ? 'Owner' : user.role === 'editor' ? 'Editor' : user.role === 'viewer' ? 'Viewer' : 'Fleet operator')}</b>${esc(user.email)}</span>${
        accountHref === null ? '' : '</a>'
      }`;
  return `  <header class="appbar">
    <span class="brand"><span class="brand__mark" aria-hidden="true">S</span><b>Skunkworks</b></span>
    ${pill}${navOf(input)}
    <div class="appbar__right">${who}</div>
  </header>`;
}

function initials(email: string): string {
  const local = email.split('@')[0] ?? email;
  const parts = local.split(/[._-]+/).filter((p) => p !== '');
  const first = parts[0]?.[0] ?? local[0] ?? '?';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return `${first}${second}`.toUpperCase();
}

/**
 * Render one document.
 *
 * `body` is trusted HTML produced by the screen builders in this directory (they
 * escape every value they interpolate). Everything else on this page is escaped here.
 */
export function layout(input: LayoutInput): string {
  const title = esc(input.title);
  const skip =
    input.chrome === 'plain'
      ? ''
      : '  <a class="skip" href="#main">Skip to content</a>\n';
  const flash =
    input.flash === undefined
      ? ''
      : `  <div class="acct__flash acct__flash--${input.flash.kind}" role="status">\n    <span>${esc(input.flash.text)}</span>\n  </div>\n`;
  const main =
    input.chrome === 'plain'
      ? `<main id="main">\n${flash}${input.body}\n</main>`
      : `<main id="main" class="page">\n${flash}${input.body}\n</main>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ADMIN_ROBOTS_META}
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
${skip}${barOf(input)}
${main}
</body>
</html>`;
}
