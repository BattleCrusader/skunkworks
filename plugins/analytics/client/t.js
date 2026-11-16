/**
 * The analytics tracker — first-party, cookieless, and small.
 *
 * Loaded by one `<script defer data-e="/_plugin/analytics/collect">` tag that the package's
 * `page.head` hook writes. Everything it sends goes to this site's own origin; nothing is
 * fetched from a third party, so there is no cross-site identifier, no cookie, no consent wall
 * for a cookie that does not exist, and nothing for an ad blocker's list to match on.
 *
 * What is measured: a pageview per load, presses on links and buttons, how far down a page was
 * read, and how long it was in front of someone. What is *not* measured: keystrokes, form values,
 * clipboard, scroll content, or anything typed anywhere.
 *
 * Honoured signals: `navigator.globalPrivacyControl` (a legal opt-out in several jurisdictions)
 * and `navigator.webdriver` (an automated browser is not a visitor). An operator who wants a
 * pause toggle has one in the package's settings, and it is enforced server-side.
 *
 * Written as ES5 on purpose: this file is shipped to whatever browser the visitor has, and a
 * syntax error in it is a silent loss of data rather than a visible break.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    for (var i = 0; i < all.length; i += 1) {
      if (all[i].getAttribute && all[i].getAttribute('data-e')) {
        script = all[i];
        break;
      }
    }
  }
  if (!script) return;
  var endpoint = script.getAttribute('data-e');
  if (!endpoint) return;

  try {
    if (navigator.globalPrivacyControl === true) return;
    if (navigator.webdriver === true) return;
  } catch (e) {
    return;
  }

  var SESSION_IDLE_MS = 30 * 60 * 1000;
  var started = now();
  var maxScroll = 0;
  var engaged = false;
  var scrollMarks = { 25: false, 50: false, 75: false, 100: false };
  var lastClick = { key: '', at: 0 };

  function now() {
    return new Date().getTime();
  }

  // ---------------------------------------------------------------- identity
  //
  // Two random values and no more. `visitor` lives in localStorage so a returning reader is
  // recognised as one; `session` lives in sessionStorage and expires after 30 idle minutes, which
  // is the same rule the dashboard uses to group a visit. Neither is derived from anything about
  // the person or the device, so there is nothing to reverse.
  function store(kind, key, value) {
    try {
      var box = kind === 's' ? window.sessionStorage : window.localStorage;
      if (value === undefined) return box.getItem(key);
      box.setItem(key, value);
      return value;
    } catch (e) {
      // Private mode, a full quota, a blocked storage API: a visit without identity is still a
      // pageview, so the id becomes per-load instead of ending the script.
      return null;
    }
  }

  function randomId() {
    var out = '';
    var bytes = 16;
    try {
      var buffer = new Uint8Array(bytes);
      (window.crypto || window.msCrypto).getRandomValues(buffer);
      for (var i = 0; i < bytes; i += 1) out += ('0' + buffer[i].toString(16)).slice(-2);
    } catch (e) {
      out = '';
      for (var j = 0; j < bytes; j += 1) out += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
    }
    return out;
  }

  var visitor = store('l', 'skwa_v');
  if (!visitor) visitor = store('l', 'skwa_v', randomId()) || randomId();

  var session = store('s', 'skwa_s');
  var lastSeen = Number(store('s', 'skwa_t') || 0);
  if (!session || !lastSeen || now() - lastSeen > SESSION_IDLE_MS) {
    session = store('s', 'skwa_s', randomId()) || randomId();
  }
  store('s', 'skwa_t', String(now()));

  // ---------------------------------------------------------------- the payload
  var ua = String(navigator.userAgent || '');
  var env = {
    d: /iPad|Tablet|PlayBook|Silk/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone|iPod/i.test(ua) ? 'mobile' : 'desktop',
    o: /Windows NT/i.test(ua)
      ? 'Windows'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/i.test(ua)
          ? 'iOS'
          : /Mac OS X/i.test(ua)
            ? 'macOS'
            : /Linux/i.test(ua)
              ? 'Linux'
              : 'other',
    b: /Edg\//i.test(ua)
      ? 'Edge'
      : /OPR\//i.test(ua)
        ? 'Opera'
        : /Firefox\//i.test(ua)
          ? 'Firefox'
          : /Chrome\//i.test(ua)
            ? 'Chrome'
            : /Safari\//i.test(ua)
              ? 'Safari'
              : 'other',
    l: String(navigator.language || '').slice(0, 24),
  };

  function base() {
    return {
      v: 1,
      sid: session,
      vid: visitor,
      p: String(location.pathname || '/').slice(0, 400),
      u: String(location.href || '').slice(0, 800),
      vw: window.innerWidth || 0,
      vh: window.innerHeight || 0,
      d: env.d,
      b: env.b,
      o: env.o,
      l: env.l,
    };
  }

  function send(payload) {
    var body;
    try {
      body = JSON.stringify(payload);
    } catch (e) {
      return;
    }
    // `text/plain` on purpose: the host parses `application/json` into an object and the endpoint
    // would receive an empty string. A string body is the one shape that arrives intact.
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, body)) return;
    } catch (e) {
      /* fall through to the XHR, which survives a navigation better than fetch() does */
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint, true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.send(body);
    } catch (e) {
      /* nothing left to try, and nothing a visitor should see */
    }
  }

  /**
   * `track` and not `event`: this function used to be named `event`, and the click handler's
   * parameter is the DOM event, so inside that one function `event('click', …)` resolved to the
   * argument and threw `event is not a function`. Every click in the world was lost to a shadowed
   * name, silently — the pageviews kept arriving, so nothing looked broken.
   * `test/plugin-analytics-tracker.test.ts` T2 is the witness that it does not come back.
   */
  function track(kind, extra) {
    var payload = base();
    payload.k = kind;
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
    }
    send(payload);
    store('s', 'skwa_t', String(now()));
  }

  // ---------------------------------------------------------------- a pageview
  //
  // `document.referrer` on the first load is the traffic source; on a later load inside the same
  // session it is still sent, and the server classifies a same-site referrer as `(internal)`
  // rather than counting the site's own navigation as acquisition.
  track('pageview', { r: String(document.referrer || '').slice(0, 800) });

  // ---------------------------------------------------------------- clicks
  function labelOf(node) {
    var attr =
      node.getAttribute('data-skw-label') ||
      node.getAttribute('data-skwa') ||
      node.getAttribute('aria-label') ||
      node.getAttribute('title');
    if (attr) return String(attr).replace(/\s+/g, ' ').trim().slice(0, 120);
    var text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 120);
  }

  function kindOf(node) {
    if (node.tagName !== 'A') return 'button';
    var href = node.getAttribute('href') || '';
    if (node.hasAttribute('download')) return 'download';
    if (/^mailto:/i.test(href)) return 'email';
    if (/^tel:/i.test(href)) return 'phone';
    if (href.charAt(0) === '#') return 'anchor';
    try {
      var url = new URL(node.href, location.href);
      return url.hostname === location.hostname ? 'internal' : 'external';
    } catch (e) {
      return 'internal';
    }
  }

  /**
   * The thing a person meant to press, not the `<span>` inside it. Bounded at eight ancestors so
   * a click on the document body never resolves to the page's outermost wrapper.
   */
  function clickableFrom(node) {
    var depth = 0;
    while (node && node !== document && depth < 8) {
      if (node.nodeType === 1) {
        if (node.hasAttribute('data-skw-ignore')) return null;
        var tag = node.tagName;
        if (tag === 'A' && node.getAttribute('href')) return node;
        if (tag === 'BUTTON' || node.getAttribute('role') === 'button' || node.hasAttribute('data-skw-track')) return node;
      }
      node = node.parentNode;
      depth += 1;
    }
    return null;
  }

  function onClick(ev) {
    var node = clickableFrom(ev.target);
    if (!node) return;
    var key = labelOf(node) + '|' + (node.getAttribute('href') || '');
    var at = now();
    // A double-press on a slow link fires twice; it is one intention.
    if (lastClick.key === key && at - lastClick.at < 500) return;
    lastClick = { key: key, at: at };

    var href = '';
    try {
      href = node.tagName === 'A' ? new URL(node.href, location.href).href.slice(0, 800) : '';
    } catch (e) {
      href = String(node.getAttribute('href') || '').slice(0, 800);
    }
    track('click', {
      t: labelOf(node),
      tu: href,
      tk: kindOf(node),
    });
  }

  try {
    document.addEventListener('click', onClick, true);
    // A keyboard "click" on a link is a press too: Enter fires `click` on the anchor, so the
    // capture listener above sees it and nothing extra is needed here.
  } catch (e) {
    /* an ancient browser without capture listeners loses clicks, not pageviews */
  }

  // ---------------------------------------------------------------- scroll depth
  function scrollPct() {
    var doc = document.documentElement;
    var height = Math.max(doc.scrollHeight || 0, document.body ? document.body.scrollHeight : 0);
    var view = window.innerHeight || doc.clientHeight || 0;
    var room = height - view;
    if (room <= 0) return 100;
    var top = window.pageYOffset || doc.scrollTop || 0;
    return Math.max(0, Math.min(100, Math.round((top / room) * 100)));
  }

  var scrollPending = false;
  function onScroll() {
    if (scrollPending) return;
    scrollPending = true;
    var run = function () {
      scrollPending = false;
      var pct = scrollPct();
      if (pct > maxScroll) maxScroll = pct;
      for (var mark in scrollMarks) {
        if (!Object.prototype.hasOwnProperty.call(scrollMarks, mark)) continue;
        if (!scrollMarks[mark] && maxScroll >= Number(mark)) {
          scrollMarks[mark] = true;
          track('scroll', { sc: Number(mark) });
        }
      }
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run);
    else setTimeout(run, 120);
  }

  try {
    window.addEventListener('scroll', onScroll, { passive: true });
  } catch (e) {
    window.addEventListener('scroll', onScroll, false);
  }

  // ---------------------------------------------------------------- engagement
  //
  // One event on the way out, carrying the time the document was open. `pagehide` fires on a
  // navigation and on a tab close; `visibilitychange` catches the tab that is backgrounded and
  // never comes back, which on mobile is most of them. `engaged` makes it exactly one.
  function onLeave() {
    if (engaged) return;
    engaged = true;
    var dwell = now() - started;
    if (dwell < 0 || dwell > 86_400_000) dwell = 0;
    track('engage', { dw: dwell, sc: maxScroll });
  }

  try {
    window.addEventListener('pagehide', onLeave, false);
    document.addEventListener(
      'visibilitychange',
      function () {
        if (document.visibilityState === 'hidden') onLeave();
      },
      false,
    );
  } catch (e) {
    /* nothing to do: the pageview is already sent */
  }
})();
