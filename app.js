/* ==== APP: routing, tabs, settings, keyboard, page transitions, small UI helpers ==== */
(function (g) {
  'use strict';

  var esc = U.esc;
  var view = document.getElementById('view'), tabsNav = document.getElementById('tabs');
  var TABS = [['top', 'Top'], ['best', 'Best'], ['foryou', 'For You'], ['new', 'New'], ['ask', 'Ask'], ['show', 'Show'], ['jobs', 'Jobs'], ['saved', 'Saved']];
  var LABEL = {}; TABS.forEach(function (t) { LABEL[t[0]] = t[1]; });
  var route = { name: 'none' }, lastTab = 'top', scrollMem = {}, restoreTab = null;

  /* ---------- Small helpers used by every view ---------- */
  var busyCount = 0;
  function busy(d) { busyCount = Math.max(0, busyCount + d); document.getElementById('updating').hidden = busyCount === 0; }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    Anim.replay(t, 'show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 1800);
  }

  function errorHTML(err, what) {
    return '<div class="error"><h2>Couldn’t load ' + esc(what) + '</h2>' +
      (navigator.onLine === false ? '<p>Your browser reports that it’s offline.</p>'
        : '<p>The request to the Hacker News API failed. If this happens every time, this page probably isn’t allowed to make network requests here (for example, a content security policy).</p>') +
      '<p>No sample data is shown in its place.</p><p><code>' + esc(err && err.message ? err.message : String(err)) + '</code></p>' +
      '<button class="btn" type="button" data-retry>Try again</button></div>';
  }

  // Navigate now rather than waiting for the browser's hashchange event, so a key pressed right
  // after (Esc) already sees the new page. The hashchange that follows is recognised and ignored.
  var replacing = false, handledHash = null;
  function go(hash, replace) {
    if (location.hash === hash) return;
    if (replace) { replacing = true; location.replace(hash); } else location.hash = hash;
    queueMicrotask(onRoute);
  }

  /* ---------- History with positions, so Back/Esc can return to where you came from ----------
     Each entry gets { i: position } in history.state; hist maps position -> hash. */
  var hist = {}, histIdx = 0;
  function track() {
    var st = history.state, h = location.hash || '#/top', traversed = false;
    if (replacing) replacing = false;
    else if (st && typeof st.i === 'number') { histIdx = st.i; traversed = true; }
    else {
      if (hist[histIdx] != null) histIdx++;
      Object.keys(hist).forEach(function (k) { if (+k > histIdx) delete hist[k]; });
    }
    hist[histIdx] = h;
    if (!st || st.i !== histIdx) history.replaceState({ i: histIdx }, '', h);
    return traversed;
  }
  function replaceHash(h) { hist[histIdx] = h; handledHash = h; history.replaceState({ i: histIdx }, '', h); }

  // The list (tab or search results) this page was opened from, skipping pages in between.
  function originIdx() {
    for (var j = histIdx - 1; j >= 0; j--) {
      if (hist[j] == null) return -1;
      var n = parse(hist[j]).name;
      if (n === 'list' || (n === 'search' && route.name !== 'search')) return j;
    }
    return -1;
  }
  // A history jump is asynchronous. While one is on its way, a second Esc must not jump again
  // (that overshot past the start of the app's history, where Back then did nothing).
  var backPending = false, backTimer = null;
  function historyJump(n) {
    if (backPending || !n) return;
    backPending = true;
    clearTimeout(backTimer);
    backTimer = setTimeout(function () { backPending = false; }, 1000);
    history.go(n);
  }
  function goBackToOrigin() {
    if (backPending) return;
    var j = originIdx();
    if (j >= 0) historyJump(j - histIdx);
    else go('#/' + lastTab);
  }

  function toggleSave(st, btn) {
    if (!st) return;
    var on = Store.toggleSave(st);
    document.querySelectorAll('[data-save="' + st.id + '"]').forEach(function (b) {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
      var star = b.querySelector('.star');
      if (star) { star.textContent = on ? '★' : '☆'; b.lastChild.textContent = on ? ' Saved' : ' Save'; }
      else b.textContent = on ? '★' : '☆';
      Anim.replay(b, 'pop');
    });
    toast(on ? 'Saved for later' : 'Removed from saved');
    if (route.name === 'list' && route.tab === 'saved') renderList();
    renderTabs();
  }

  /* ---------- Theme ---------- */
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    var pref = Store.pref('theme');
    document.documentElement.setAttribute('data-theme', pref === 'dark' || (pref === 'auto' && mq.matches) ? 'dark' : 'light');
    document.querySelectorAll('[data-theme-pref]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-pref') === pref));
    });
  }
  mq.addEventListener('change', applyTheme);

  /* ---------- Tabs ---------- */
  // Only rebuilt when something in it changed: rebuilding on every loading tick replaced the
  // tab under your finger or mouse mid-click, so the click was lost.
  var tabsHTML = '';
  function renderTabs() {
    var active = route.name === 'list' ? route.tab : lastTab;
    var html = TABS.map(function (t) {
      var s = Lists.state[t[0]], n = null;
      if (s && (s.loadedAt || s.snapshotAt || s.painted)) n = s.stories.length;
      if (t[0] === 'saved' && Store.saved().length) n = Store.saved().length;
      return '<a class="tab" href="#/' + t[0] + '"' + (t[0] === active ? ' aria-current="page"' : '') + '>' + t[1] +
        (n != null ? '<span class="count">' + n + '</span>' : '') + '</a>';
    }).join('') + '<a class="tab search-tab" href="#/search"' + (route.name === 'search' ? ' aria-current="page"' : '') + '>Search<kbd class="kb-only">/</kbd></a>';
    if (html === tabsHTML) return;
    var activeChanged = html.replace(/<span class="count">\d+<\/span>/g, '') !== tabsHTML.replace(/<span class="count">\d+<\/span>/g, '');
    tabsHTML = html;
    tabsNav.innerHTML = html;
    // Phones: keep the current tab in view in the scrollable tab bar.
    var cur = tabsNav.querySelector('[aria-current]');
    if (activeChanged && cur && tabsNav.scrollWidth > tabsNav.clientWidth) {
      var l = cur.offsetLeft, r = l + cur.offsetWidth;
      if (l < tabsNav.scrollLeft || r > tabsNav.scrollLeft + tabsNav.clientWidth) tabsNav.scrollLeft = Math.max(0, l - 24);
    }
  }

  /* ---------- Routing ---------- */
  function parse(hash) {
    var h = (hash == null ? location.hash || '' : hash).replace(/^#\/?/, ''), m;
    if ((m = /^item\/(\d+)(?:\/(\d+))?/.exec(h))) return { name: 'item', id: +m[1], focus: m[2] ? +m[2] : null };
    if ((m = /^split\/(\d+)/.exec(h))) return { name: 'split', id: +m[1] };
    if ((m = /^read\/(\d+)/.exec(h))) return { name: 'read', id: +m[1] };
    if ((m = /^user\/(.+)$/.exec(h))) { var n = m[1]; try { n = decodeURIComponent(n); } catch (e) {} return { name: 'user', id: n }; }
    if (/^search/.test(h)) return { name: 'search', qs: h.split('?')[1] || '' };
    var tab = h.split(/[/?]/)[0];
    return { name: 'list', tab: LABEL[tab] ? tab : 'top' };
  }

  function back() {
    var j = originIdx();
    if (j >= 0 && parse(hist[j]).name === 'search') return { href: hist[j], label: 'Search results' };
    return { href: '#/' + lastTab, label: LABEL[lastTab] };
  }

  function renderList() {
    var t = route.tab;
    if (t === 'foryou') Views.renderForYou(view);
    else if (t === 'saved') Views.renderSaved(view);
    else Views.renderSource(view, t, LABEL[t]);
    if (restoreTab === t && view.querySelector('.story')) {
      restoreTab = null;
      window.scrollTo(0, scrollMem[t] || 0);
    }
  }

  var curNav = { id: 0, signal: null };
  function renderRoute() {
    document.body.classList.toggle('is-split', route.name === 'split');
    if (route.name !== 'split' && route.name !== 'read') Split.leave();
    if (route.name !== 'search') Search.leave();
    // Release focus left on the old page (a button, or an embedded article that swallows keys).
    var a = document.activeElement;
    if (a && a !== document.body && (view.contains(a) || !a.isConnected)) a.blur();
    var nav = curNav;
    if (route.name === 'list') {
      document.title = 'The Hundred · ' + LABEL[route.tab];
      if (route.tab !== 'saved') Lists.ensure(route.tab);
      renderList();
      Nav.done(nav.id, 'list ' + route.tab);
    } else {
      view.setAttribute('data-view', route.name);
      if (route.name === 'item') Comments.render(route.id, route.focus, view, { back: back(), nav: nav });
      else if (route.name === 'split') Split.render(route.id, view, { href: '#/item/' + route.id, label: 'Comments only' }, nav);
      else if (route.name === 'read') Split.reader(route.id, view, back(), nav);
      else if (route.name === 'user') User.render(route.id, view, back(), nav);
      else if (route.name === 'search') Search.render(view, route.qs, searchBack, nav);
      if (!Lists.state[lastTab] || !Lists.state[lastTab].loadedAt) Lists.ensure(lastTab === 'saved' ? 'top' : lastTab);
    }
    renderTabs();
  }

  var searchBack = null, navToken = 0;
  function onRoute() {
    var h = location.hash;
    if (h === handledHash) return;            // already handled (go() routes immediately)
    handledHash = h;
    h = h || '#/top';
    backPending = false;
    var traversed = false;
    try { traversed = track(); } catch (e) { console.error(e); }
    var prev = route, next = parse();
    if (prev.name === 'search' && next.name === 'search') { renderTabs(); return; }   // search edits its own URL
    // New page visit: cancel the previous page's requests; anything that still arrives is ignored.
    curNav = Nav.start(h);
    try { endDwell(prev); } catch (e) {}
    if (prev.name === 'list') scrollMem[prev.tab] = window.scrollY;
    if (prev.name === 'search') scrollMem.search = window.scrollY;
    route = next;
    var toTop = false;
    searchBack = null;
    if (next.name === 'list') {
      restoreTab = prev.name !== 'list' && prev.name !== 'none' && lastTab === next.tab ? next.tab : null;
      toTop = !restoreTab;
      lastTab = next.tab;
    } else if (next.name === 'search') {
      // Returning to results (Esc, Back): same results, scroll and selection. Otherwise a fresh search.
      if (traversed && prev.name !== 'none') searchBack = { y: scrollMem.search || 0 };
      toTop = !searchBack && prev.name !== 'none';
    } else toTop = prev.name !== 'none';
    startDwell(next);
    var dir = prev.name === 'none' ? null : next.name === 'list' && prev.name === 'list' ? 'tab'
      : next.name === 'list' || searchBack ? 'back' : 'fwd';
    // Latest navigation wins: an older page update that runs late (because its transition was
    // skipped) does nothing. Errors are caught and shown instead of leaving a half-drawn page.
    var my = ++navToken;
    var paint = function () {
      if (my !== navToken) return;
      try { if (toTop) window.scrollTo(0, 0); renderRoute(); }
      catch (err) {
        console.error(err);
        Nav.log('error', 'drawing ' + h + ': ' + (err && err.message));
        view.removeAttribute('data-view'); view.innerHTML = errorHTML(err, 'this page');
      }
    };
    if (dir) Anim.page(dir, paint); else paint();
  }

  function reroute() { searchBack = null; navToken++; renderRoute(); }

  /* ---------- Time spent on a story (For You signal) ---------- */
  var READING = { item: 1, split: 1, read: 1 };
  var dwell = { start: 0, acc: 0 };
  function startDwell(r) { dwell = { start: READING[r.name] && !document.hidden ? Date.now() : 0, acc: 0 }; }
  function endDwell(r) {
    if (!READING[r.name]) return;
    var c = r.name === 'read' ? { story: Split.story() } : Comments.current();
    var ms = dwell.acc + (dwell.start ? Date.now() - dwell.start : 0);
    if (c && c.story && ms > 30000) Store.learn(c.story, Math.min(4, ms / 60000 * 0.5));
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && dwell.start) { dwell.acc += Date.now() - dwell.start; dwell.start = 0; }
    else if (!document.hidden && READING[route.name]) dwell.start = Date.now();
  });

  /* ---------- Help and settings ---------- */
  var KEYS = [
    ['Anywhere', [['/', 'Search'], ['?', 'This help'], [',', 'Settings'], ['1–8', 'Switch tab'], ['Esc', 'Back / close']]],
    ['Story lists', [['j / k', 'Next / previous story'], ['Enter or o', 'Open article (comments for text posts)'], ['c', 'Comments'],
      ['s', 'Save / unsave'], ['v', 'Side by side']]],
    ['Comments', [['j / k', 'Next / previous comment'], ['n / p', 'Next / previous top-level comment'], ['l or →', 'Open replies, go in'],
      ['h or ←', 'Go to parent'], ['r', 'Toggle replies'], ['a', 'Show parent comment'], ['u', 'Next new comment'],
      ['s', 'Save story'], ['o', 'Open article'], ['v', 'Side by side on / off']]],
    ['Reader view', [['j / k', 'Scroll down / up a little'], ['d / u', 'Half a page down / up'], ['Space / ⇧ Space', 'A page down / up'],
      ['gg / G', 'Top / bottom'], ['c', 'Jump to the comments'], ['o', 'Open the original in a new tab']]],
    ['Side by side', [['Tab', 'Switch between article and comments keys'], ['v', 'Back to comments only']]]
  ];
  function openHelp() {
    var d = document.getElementById('dialog');
    d.innerHTML = '<form method="dialog"><h2>Keyboard shortcuts</h2><div class="keys">' + KEYS.map(function (sec) {
      return '<section><h3>' + sec[0] + '</h3><dl>' + sec[1].map(function (k) { return '<dt><kbd>' + k[0] + '</kbd></dt><dd>' + k[1] + '</dd>'; }).join('') + '</dl></section>';
    }).join('') + '</div><button class="btn" value="close">Close</button></form>';
    d.showModal();
  }

  function openSettings() {
    var d = document.getElementById('dialog');
    function seg(name, opts, cur) {
      return '<span class="seg">' + opts.map(function (o) {
        return '<button type="button" data-pref="' + name + '" data-val="' + o[0] + '" aria-pressed="' + (String(cur) === String(o[0])) + '">' + o[1] + '</button>';
      }).join('') + '</span>';
    }
    function paint() {
      d.innerHTML = '<form method="dialog" class="settings"><h2>Settings</h2>' +
        '<div class="row"><span>Theme</span>' + seg('theme', [['light', 'Light'], ['auto', 'Auto'], ['dark', 'Dark']], Store.pref('theme')) + '</div>' +
        '<div class="row"><span>Markdown-style formatting in comments</span>' + seg('md', [[true, 'On'], [false, 'Off']], Store.pref('md')) + '</div>' +
        '<div class="row"><span>Comment order</span>' + seg('order', [['top', 'HN ranking'], ['new', 'Newest first']], Store.pref('order')) + '</div>' +
        '<div class="row"><span>Auto-open replies that contain new comments</span>' + seg('autoOpen', [[true, 'On'], [false, 'Off']], Store.pref('autoOpen')) + '</div>' +
        '<h3>Followed topics</h3><p class="hint">Matching stories get a subtle highlight and rank higher in For You. Nothing is hidden.</p>' +
        '<div class="chips">' + Store.topics().map(function (t, i) {
          return '<span class="chip">' + esc(t) + '<button type="button" data-rm-topic="' + i + '" aria-label="Remove ' + esc(t) + '">×</button></span>';
        }).join('') + '<input class="topic-input" placeholder="Add a topic, e.g. Rust" aria-label="Add a topic"></div>' +
        '<h3>For You</h3><p class="hint">Learns only from what you open, save and spend time on, stored in this browser. Currently ' +
          U.plural(Store.modelSize(), 'interest') + '. <button type="button" class="linkbtn" data-reset-model>Reset learning</button></p>' +
        '<p class="hint">Side-by-side Reader view fetches a text version of the article through r.jina.ai, which sees the article’s URL.</p>' +
        '<h3>Debug log</h3><div class="row"><span>Record the last 20 navigation events (kept across reloads)</span>' +
          seg('debug', [[true, 'On'], [false, 'Off']], Store.pref('debug')) + '</div>' +
        (Store.pref('debug') ? '<textarea class="navlog" readonly rows="8" aria-label="Navigation log">' +
          esc(Nav.entries().join('\n') || 'Nothing recorded yet.') + '</textarea>' +
          '<p class="hint"><button type="button" class="linkbtn" data-copy-log>Copy log</button> · ' +
          '<button type="button" class="linkbtn" data-clear-log>Clear</button></p>' : '') +
        '<button class="btn" value="close">Done</button></form>';
    }
    paint();
    d.onclick = function (e) {
      var b = e.target.closest('[data-pref],[data-rm-topic],[data-reset-model],[data-copy-log],[data-clear-log]');
      if (!b) return;
      if (b.hasAttribute('data-copy-log')) {
        var ta = d.querySelector('.navlog');
        var text = 'The Hundred navigation log\n' + navigator.userAgent + '\n\n' + ta.value;
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
          .then(function () { toast('Log copied'); }, function () { ta.select(); toast('Press ⌘C to copy'); });
        return;
      }
      if (b.hasAttribute('data-clear-log')) { Nav.clear(); paint(); return; }
      if (b.hasAttribute('data-pref')) {
        var v = b.getAttribute('data-val'); v = v === 'true' ? true : v === 'false' ? false : v;
        var name = b.getAttribute('data-pref');
        Store.setPref(name, v);
        if (name === 'debug') { if (v) Nav.log('start', 'debug log turned on at ' + location.hash); }
        else if (name === 'theme') applyTheme();
        else if (route.name === 'item') { if (!Comments.rerender()) reroute(); }
        else if (route.name !== 'list') reroute();
      } else if (b.hasAttribute('data-rm-topic')) {
        var t = Store.topics().slice(); t.splice(+b.getAttribute('data-rm-topic'), 1); Store.setTopics(t);
      } else { Store.resetModel(); toast('For You learning reset'); }
      paint();
      if (route.name === 'list') renderList();
    };
    d.onkeydown = function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('topic-input')) {
        e.preventDefault();
        if (e.target.value.trim()) { Store.setTopics(Store.topics().concat(e.target.value)); paint(); d.querySelector('.topic-input').focus(); if (route.name === 'list') renderList(); }
      }
    };
    d.showModal();
    var inp = d.querySelector('.topic-input'); if (inp && !Store.topics().length) inp.blur();
  }

  /* ---------- Clicks ---------- */
  document.addEventListener('click', function (e) {
    // Opening a story from a list remembers it as the selected row for when you come back.
    var srow = e.target.closest('.story[data-id]');
    if (srow && e.target.closest('a') && (route.name === 'list' || route.name === 'search')) Views.selectRow(view, srow, true);
    // "← Back" returns through history to the list you came from (same place, same selection).
    var bk = e.target.closest('a.back'), oj = bk ? originIdx() : -1;
    if (bk && oj >= 0 && bk.getAttribute('href') === hist[oj]) { e.preventDefault(); historyJump(oj - histIdx); return; }
    var t = e.target.closest('[data-save],[data-open-article],[data-refresh],[data-retry],[data-open-settings],[data-theme-pref],[data-open-help]');
    if (!t) { if (route.name === 'item' || route.name === 'split') Comments.click(e); return; }
    if (t.hasAttribute('data-save')) { e.preventDefault(); toggleSave(Views.story(+t.getAttribute('data-save')) || (Comments.current() || {}).story, t); }
    else if (t.hasAttribute('data-open-article')) {
      var row = t.closest('.story'), st = row ? Views.story(+row.getAttribute('data-id')) : (Comments.current() || {}).story;
      if (st && t.getAttribute('target') === '_blank') { Views.markOpened(st); if (row) row.classList.add('is-read'); }
    }
    else if (t.hasAttribute('data-refresh')) Lists.refreshAll(route.tab);
    else if (t.hasAttribute('data-retry')) { if (route.name === 'list') Lists.refreshAll(route.tab); else reroute(); }
    else if (t.hasAttribute('data-open-settings')) openSettings();
    else if (t.hasAttribute('data-open-help')) openHelp();
    else if (t.hasAttribute('data-theme-pref')) { Store.setPref('theme', t.getAttribute('data-theme-pref')); applyTheme(); }
    if (route.name === 'item' || route.name === 'split') Comments.click(e);
  });

  /* ---------- Hover prefetch ---------- */
  var hoverTimer = null, hoverId = null;
  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest && e.target.closest('.story[data-id], a[href^="#/item/"]'), id = null;
    if (el) id = el.hasAttribute('data-id') ? +el.getAttribute('data-id') : +((/^#\/item\/(\d+)/.exec(el.getAttribute('href')) || [])[1] || 0);
    if (id === hoverId) return;
    hoverId = id;
    clearTimeout(hoverTimer);
    if (id) hoverTimer = setTimeout(function () { Thread.prefetch(id); }, 120);
  });
  // Phones have no hover: start loading a thread as soon as a finger lands on its story.
  document.addEventListener('touchstart', function (e) {
    var row = e.target.closest && e.target.closest('.story[data-id]');
    if (row) Thread.prefetch(+row.getAttribute('data-id'));
  }, { passive: true });

  /* ---------- Swipe from the left edge to go back (phones) ----------
     Skipped in iPhone Safari's browser tab, which already has its own edge swipe. If the
     system's own back gesture already navigated, ours does nothing. */
  var swipe = null;
  var nativeSwipe = navigator.standalone === false;
  document.addEventListener('touchstart', function (e) {
    if (nativeSwipe || route.name === 'list' || e.touches.length !== 1) return;
    var t = e.touches[0];
    if (t.clientX > 24) return;
    swipe = { x: t.clientX, y: t.clientY, dx: 0, nav: Nav.id };
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!swipe) return;
    var t = e.touches[0];
    swipe.dx = t.clientX - swipe.x;
    if (Math.abs(t.clientY - swipe.y) > 60) { swipe = null; view.style.transform = ''; return; }
    if (Anim.ok() && swipe.dx > 0) view.style.transform = 'translateX(' + Math.min(80, swipe.dx * 0.35) + 'px)';
  }, { passive: true });
  function endSwipe() {
    if (!swipe) return;
    var s = swipe; swipe = null;
    view.style.transform = '';
    if (s.dx > 80) setTimeout(function () { if (Nav.id === s.nav) goBackToOrigin(); }, 60);
  }
  document.addEventListener('touchend', endSwipe, { passive: true });
  document.addEventListener('touchcancel', function () { swipe = null; view.style.transform = ''; }, { passive: true });

  /* ---------- Errors never pass silently ---------- */
  addEventListener('error', function (e) { Nav.log('error', (e.message || 'error') + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno); });
  addEventListener('unhandledrejection', function (e) {
    if (HN.isAbort(e.reason)) { e.preventDefault(); return; }    // cancelled requests are expected
    Nav.log('error', 'unhandled: ' + (e.reason && e.reason.message || e.reason));
  });

  /* ---------- Keyboard ---------- */
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing || document.querySelector('dialog[open]')) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.key === '?') { openHelp(); e.preventDefault(); return; }
    if (k === '/') { e.preventDefault(); if (route.name === 'search') Search.focus(view); else go('#/search'); return; }
    if (k === ',') { openSettings(); return; }
    if (/^[1-8]$/.test(k)) { go('#/' + TABS[+k - 1][0]); return; }
    if (k === 'Escape') {
      var peek = document.querySelector('.peek');
      if (peek) { peek.remove(); return; }
      if (route.name !== 'list') goBackToOrigin();
      return;
    }
    // Side by side: Tab picks which half the keys control.
    if (route.name === 'split' && e.key === 'Tab') { Split.toggleSide(); e.preventDefault(); return; }
    // Reader view (on its own, or the article half of side by side) uses only its own keys.
    if (route.name === 'read' || (route.name === 'split' && Split.side() === 'article')) {
      var rs = Split.story();
      if (Split.key(e)) e.preventDefault();
      else if (k === 's' && rs) { toggleSave(rs); e.preventDefault(); }
      else if (k === 'v' && rs) { go(route.name === 'split' ? '#/item/' + route.id : '#/split/' + route.id); e.preventDefault(); }
      return;
    }
    var handled = false;
    if (route.name === 'list' || route.name === 'search') handled = Views.key(view, k);
    else if (route.name === 'item' || route.name === 'split') {
      var c = Comments.current();
      handled = Comments.key(k);
      if (!handled && c) {
        if (k === 's') { toggleSave(c.story); handled = true; }
        else if (k === 'o' || k === 'Enter') { if (c.story.url) { Views.markOpened(c.story); window.open(c.story.url, '_blank', 'noopener'); } handled = true; }
        else if (k === 'v') { go(route.name === 'split' ? '#/item/' + route.id : c.story.url ? '#/split/' + route.id : '#/item/' + route.id); handled = true; }
      }
    }
    if (handled) e.preventDefault();
  });

  /* ---------- Live updates ---------- */
  Lists.onChange(function () { renderTabs(); if (route.name === 'list') renderList(); });
  Store.on(function (what) { if (what === 'topics' || what === 'model') renderTabs(); });
  setInterval(function () { if (route.name === 'list' && !document.hidden) renderList(); }, 30000);

  g.App = {
    busy: busy, toast: toast, errorHTML: errorHTML, go: go, reroute: reroute, toggleSave: toggleSave, replaceHash: replaceHash,
    currentSource: function () { var t = route.name === 'list' ? route.tab : lastTab; return Lists.state[t] ? t : null; }
  };

  /* ---------- Offline + instant repeat visits (only when hosted, e.g. GitHub Pages) ----------
     The service worker serves the app from its cache, checks for a newer version in the
     background, and tells us when one is ready. Opened from a local file, this is skipped. */
  function showUpdate() {
    if (document.getElementById('update-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.className = 'update-bar';
    bar.innerHTML = '<span>A new version of The Hundred is ready.</span><button type="button" class="btn" data-reload>Reload</button>' +
      '<button type="button" class="linkbtn" data-dismiss>Later</button>';
    bar.addEventListener('click', function (e) {
      if (e.target.closest('[data-reload]')) location.reload();
      if (e.target.closest('[data-dismiss]')) bar.remove();
    });
    document.body.appendChild(bar);
  }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // A newer service worker file: it installs fresh files, then asks us to reload.
        reg.addEventListener('updatefound', function () {
          var w = reg.installing;
          if (w && navigator.serviceWorker.controller) w.addEventListener('statechange', function () { if (w.state === 'activated') showUpdate(); });
        });
        setInterval(function () { reg.update().catch(function () {}); }, 30 * 60000);
      }).catch(function (e) { console.warn('Offline support unavailable:', e); });
      navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'update-ready') showUpdate(); });
    });
  }

  applyTheme();
  addEventListener('hashchange', onRoute);
  onRoute();
})(window);
