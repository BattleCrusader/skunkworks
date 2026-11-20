/**
 * The navigation pilot — one small same-origin script that makes both surfaces behave like an app
 * without making them one.
 *
 * ## Why a fetch-and-swap rather than a fragment endpoint
 *
 * The served document is already the cheapest thing to fetch: the browser has the sheet, the fonts
 * and the theme cached by hash, so a navigation costs the HTML and nothing else. A fragment endpoint
 * would mean a second document shape for the same page — a second renderer to drift, a second set of
 * tests, and every plugin filter (`content.render.html`, `page.head`, declared forms) needing to
 * answer "did you mean the fragment or the page?". Swapping `<main>` out of the real document keeps
 * one renderer: what the pilot paints is byte-for-byte what a reload would have painted.
 *
 * ## What is NOT intercepted, on purpose
 *
 * Anything where a real navigation is the correct behaviour: a form submission (the POST/303/CSRF
 * dance belongs to the browser), a link with `download`, `target` other than `_self`, a
 * `data-skw-noajax` ancestor, a modifier key or non-primary button, a cross-origin or non-http(s)
 * href, a same-document hash, and any fetch that fails — that last one falls back to
 * `location.href`, so the pilot can never strand a reader on a page it failed to load.
 *
 * ## The contract it keeps with the document it swaps in
 *
 * `<main>` innerHTML, `<title>`, `body[data-page-path]`, and the per-page `<link rel=stylesheet>`
 * (a page may own a sheet; the previous page's must not leak). Inline `<script>` inside the new
 * main is re-created so it runs, re-stamped with the current document's CSP nonce — admin screens
 * carry nonce'd inline scripts, and a node injected through `innerHTML` never executes.
 *
 * ## Verifying it
 *
 * `window.__skwNav = {swaps, fetches, fallbacks}` counts what happened; a swap means no document
 * load happened. Anything that resets those counters to zero proves a reload, which is the only
 * measurement that distinguishes "AJAX" from "looks fast".
 */

export const NAV_PILOT_JS = String.raw`(function () {
  'use strict';
  if (window.__skwNavLoaded) return;
  window.__skwNavLoaded = true;

  var self = document.currentScript;
  var mode = (self && self.getAttribute('data-mode')) || 'site';
  var stats = (window.__skwNav = { mode: mode, swaps: 0, fetches: 0, fallbacks: 0 });
  var pages = new Map();
  var seq = 0;

  function currentNonce() {
    var s = document.querySelector('script[nonce], style[nonce]');
    if (!s) return '';
    return s.nonce || s.getAttribute('nonce') || '';
  }

  function sameOrigin(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin && (u.protocol === 'http:' || u.protocol === 'https:');
    } catch (e) {
      return false;
    }
  }

  function plainClick(ev) {
    if (ev.defaultPrevented) return false;
    if (ev.button !== 0) return false;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return false;
    return true;
  }

  // Every reason a click must stay a real navigation.
  function refuse(link) {
    if (!link || !link.href) return true;
    if (link.hasAttribute('download')) return true;
    if (link.getAttribute('target') && link.getAttribute('target') !== '_self') return true;
    if (link.closest('[data-skw-noajax]')) return true;
    if (!sameOrigin(link.href)) return true;
    var here = new URL(location.href);
    var there = new URL(link.href);
    if (there.hash && there.pathname === here.pathname && there.search === here.search) return true;
    if (there.href === location.href) return true;
    return false;
  }

  function fetchPage(url) {
    if (pages.has(url)) return pages.get(url);
    var p = fetch(url, {
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { 'x-skw-nav': '1', 'accept': 'text/html' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        var type = res.headers.get('content-type') || '';
        if (type.indexOf('text/html') === -1) throw new Error('not html');
        return res.text();
      })
      .then(function (html) {
        return new DOMParser().parseFromString(html, 'text/html');
      })
      .catch(function (err) {
        pages.delete(url);
        throw err;
      });
    pages.set(url, p);
    // The cache is parsed documents in memory, which is what makes a hover worth doing at all:
    // site documents are cache-control: no-store, so the HTTP cache throws the response away and
    // only this Map keeps it. Which makes an unbounded Map a leak on a long session — keep the last
    // handful and let the rest be fetched again.
    while (pages.size > 8) {
      var oldest = pages.keys().next().value;
      if (oldest === undefined) break;
      pages.delete(oldest);
    }
    return p;
  }

  function runInline(root) {
    var nonce = currentNonce();
    var list = root.querySelectorAll('script');
    for (var i = 0; i < list.length; i += 1) {
      var old = list[i];
      if (old.src) continue;
      var s = document.createElement('script');
      if (nonce) s.setAttribute('nonce', nonce);
      s.textContent = old.textContent;
      old.parentNode.replaceChild(s, old);
    }
  }

  function syncSheets(doc) {
    var wanted = [];
    var links = doc.head.querySelectorAll('link[rel="stylesheet"][href]');
    for (var i = 0; i < links.length; i += 1) wanted.push(new URL(links[i].getAttribute('href'), location.href).href);
    var have = document.querySelectorAll('link[data-skw-nav-sheet]');
    for (var j = 0; j < have.length; j += 1) {
      var el = have[j];
      if (wanted.indexOf(el.href) === -1) el.parentNode.removeChild(el);
    }
    var existing = [];
    var all = document.querySelectorAll('link[rel="stylesheet"][href]');
    for (var k = 0; k < all.length; k += 1) existing.push(all[k].href);
    for (var m = 0; m < wanted.length; m += 1) {
      if (existing.indexOf(wanted[m]) !== -1) continue;
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = wanted[m];
      link.setAttribute('data-skw-nav-sheet', '1');
      document.head.appendChild(link);
    }
  }

  function markCurrent(path) {
    var links = document.querySelectorAll('.site-menu a, .appbar nav a');
    for (var i = 0; i < links.length; i += 1) {
      var a = links[i];
      var url = new URL(a.getAttribute('href') || '/', location.href);
      if (url.pathname === path) a.setAttribute('aria-current', 'page');
      else if (a.getAttribute('aria-current') === 'page') a.removeAttribute('aria-current');
    }
  }

  function swap(doc, url, opts) {
    var next = doc.querySelector('main');
    var current = document.querySelector('main');
    if (!next || !current) throw new Error('no main');

    document.title = doc.title;
    var path = doc.body ? doc.body.getAttribute('data-page-path') : null;
    if (path) document.body.setAttribute('data-page-path', path);

    current.innerHTML = next.innerHTML;
    syncSheets(doc);
    runInline(current);

    history[opts.replace ? 'replaceState' : 'pushState']({ skw: 1, y: window.scrollY }, '', url);

    var y = opts.y;
    window.scrollTo(0, typeof y === 'number' ? y : 0);
    if (!current.hasAttribute('tabindex')) current.setAttribute('tabindex', '-1');
    if (opts.focus !== false) current.focus({ preventScroll: true });
    markCurrent(new URL(url, location.href).pathname);
    stats.swaps += 1;
    document.documentElement.classList.remove('skw-nav-busy');
  }

  function go(url, opts) {
    opts = opts || {};
    var my = ++seq;
    document.documentElement.classList.add('skw-nav-busy');
    stats.fetches += 1;
    return fetchPage(url).then(
      function (doc) {
        if (my !== seq) return null;
        swap(doc, url, opts);
        return true;
      },
      function () {
        if (my !== seq) return null;
        stats.fallbacks += 1;
        document.documentElement.classList.remove('skw-nav-busy');
        location.href = url;
        return false;
      }
    );
  }
  window.__skwNav.go = go;

  document.addEventListener('click', function (ev) {
    if (!plainClick(ev)) return;
    var link = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!link || refuse(link)) return;
    // A form's submit button is sometimes an <a> inside a <form>; that is the browser's.
    if (link.closest('form')) return;
    ev.preventDefault();
    go(link.href);
  });

  document.addEventListener('submit', function (ev) {
    // Belt and braces: a form always navigates for real unless it opted in.
    if (ev.target && ev.target.getAttribute('data-skw-ajax') === '1') return;
    seq += 1;
  }, true);

  // Warm the next page on intent, so a click usually paints from an already-fetched document.
  document.addEventListener('pointerover', function (ev) {
    var link = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!link || refuse(link)) return;
    fetchPage(link.href).catch(function () {});
  });

  window.addEventListener('popstate', function (ev) {
    if (!ev.state || !ev.state.skw) return;
    go(location.href, { y: ev.state.y || 0, replace: true });
  });
})();
`;
