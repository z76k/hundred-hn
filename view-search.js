/* ==== VIEW: search (Algolia) ====
   Stories and comments; filters for type, date range, minimum points/comments; sort by
   relevance, popularity, or date. Ignores the 100-comment rule. State lives in the URL. */
(function (g) {
  'use strict';

  var esc = U.esc, token = 0, timer = null, params = {}, results = [], lastPage = 0, pages = 0;
  var lastQs = null, statusHTML = '', restoreY = null;
  var RANGES = { any: 0, day: 86400, week: 604800, month: 2592000, year: 31536000 };

  function parse(qs) {
    var p = new URLSearchParams(qs || '');
    return { q: p.get('q') || '', type: p.get('type') || 'story', sort: p.get('sort') || 'relevance',
      range: p.get('range') || 'any', points: p.get('points') || '', comments: p.get('comments') || '' };
  }
  function toQuery(p) {
    var o = new URLSearchParams();
    Object.keys(p).forEach(function (k) {
      var def = { type: 'story', sort: 'relevance', range: 'any' }[k];
      if (p[k] && p[k] !== def) o.set(k, p[k]);
    });
    var s = o.toString();
    return '#/search' + (s ? '?' + s : '');
  }

  function opt(name, val, cur, label) {
    return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + label + '</option>';
  }

  function formHTML(p) {
    return '<form class="search-form" autocomplete="off" onsubmit="return false">' +
      '<input type="search" name="q" class="search-input" placeholder="Search Hacker News stories and comments…" value="' + esc(p.q) + '" aria-label="Search">' +
      '<div class="filters">' +
        '<label>Type <select name="type">' + opt('', 'story', p.type, 'Stories') + opt('', 'ask', p.type, 'Ask HN') +
          opt('', 'show', p.type, 'Show HN') + opt('', 'comment', p.type, 'Comments') + opt('', 'all', p.type, 'Everything') + '</select></label>' +
        '<label>Sort <select name="sort">' + opt('', 'relevance', p.sort, 'Relevance') + opt('', 'popular', p.sort, 'Popularity') +
          opt('', 'date', p.sort, 'Newest') + '</select></label>' +
        '<label>Date <select name="range">' + opt('', 'any', p.range, 'Any time') + opt('', 'day', p.range, 'Past 24 hours') +
          opt('', 'week', p.range, 'Past week') + opt('', 'month', p.range, 'Past month') + opt('', 'year', p.range, 'Past year') + '</select></label>' +
        '<label class="num">Min points <input type="number" name="points" min="0" step="10" value="' + esc(p.points) + '"></label>' +
        '<label class="num">Min comments <input type="number" name="comments" min="0" step="10" value="' + esc(p.comments) + '"></label>' +
      '</div></form><div class="status search-status" role="status"></div><div class="list-body search-results"></div>';
  }

  function commentHit(h) {
    var sid = h.storyId;
    return '<li class="hit-comment">' +
      '<div class="c-meta"><a class="by" href="#/user/' + encodeURIComponent(h.by || '') + '">' + esc(h.by || 'unknown') + '</a>' +
        '<span title="' + esc(U.fullDate(h.time)) + '">' + esc(U.timeAgo(h.time)) + '</span>' +
        (sid ? '<span>on <a href="#/item/' + sid + '">' + esc(h.storyTitle || 'story') + '</a></span>' : '') + '</div>' +
      '<div class="rich clamp">' + U.richHTML(h.text) + '</div>' +
      (sid ? '<a class="hit-open" href="#/item/' + sid + '/' + h.id + '">View in thread →</a>' : '') + '</li>';
  }

  // animate: only for a fresh set of results, never when coming back to them.
  function paintResults(view, animate) {
    var box = view.querySelector('.search-results');
    if (!box) return;
    box.innerHTML = results.length ? '<ol class="list">' + results.map(function (h, i) {
      return h.type === 'comment' ? commentHit(h) : Views.rowHTML(h, i, { enter: animate && i < 14 && i >= lastPage * 40 ? (i % 40) + 1 : 0 });
    }).join('') + '</ol>' + (lastPage + 1 < pages ? '<button type="button" class="btn more" data-more>More results</button>' : '') : '';
    Views.applySel(view);
    if (restoreY != null) { window.scrollTo(0, restoreY); restoreY = null; }
  }

  function setStatus(view, html) {
    statusHTML = html;
    var el = view.querySelector('.search-status');
    if (el) el.innerHTML = html;
  }

  // Results are used only if this search is still the page on screen.
  var nav = { id: 0, signal: null };
  function live(my) { return my === token && Nav.alive(nav.id) && document.querySelector('[data-view="search"]'); }

  function run(view, page) {
    var my = ++token, p = params;
    var filtered = p.points || p.comments || p.range !== 'any' || p.type === 'ask' || p.type === 'show';
    if (!p.q.trim() && !filtered) {
      results = []; pages = 0;
      setStatus(view, '<span>Type to search all of Hacker News. Filters narrow it down; nothing here follows the 100-comment rule.</span>');
      paintResults(view, false);
      return;
    }
    setStatus(view, '<span class="dot busy"></span><span>Searching…</span>');
    HN.search({ q: p.q, type: p.type, sort: p.sort, page: page || 0,
      since: RANGES[p.range] ? Math.floor(Date.now() / 1000) - RANGES[p.range] : 0,
      points: Number(p.points) || 0, comments: Number(p.comments) || 0 }, nav.signal).then(function (r) {
      if (!live(my)) return;
      lastPage = r.page; pages = r.pages;
      results = page ? results.concat(r.hits) : r.hits;
      setStatus(view, '<span>' + r.total.toLocaleString() + ' result' + (r.total === 1 ? '' : 's') +
        (p.sort === 'popular' ? ' · most points first within each page of matches' : '') + '</span>');
      paintResults(view, restoreY == null);
      Nav.done(nav.id, 'search results');
    }, function (e) {
      if (!live(my) || HN.isAbort(e)) return;
      Nav.log('error', 'search: ' + e.message);
      setStatus(view, '<span class="dot err"></span><span>Search failed: ' + esc(e.message) + ' </span><button type="button" class="linkbtn" data-retry-search>Try again</button>');
    });
  }

  /* back: { y } when returning to these results (Esc / Back) — keeps results, scroll and selection.
     navInfo: { id, signal } for this visit; leaving cancels the search in flight. */
  function render(view, qs, back, navInfo) {
    nav = navInfo || { id: Nav.id, signal: null };
    clearTimeout(timer);
    params = parse(qs);
    document.title = 'Search · The Hundred';
    view.setAttribute('data-view', 'search');
    view.innerHTML = formHTML(params);
    var form = view.querySelector('form');
    function changed(immediate) {
      var fd = new FormData(form);
      params = { q: fd.get('q') || '', type: fd.get('type'), sort: fd.get('sort'), range: fd.get('range'),
        points: fd.get('points') || '', comments: fd.get('comments') || '' };
      var h = toQuery(params);
      App.replaceHash(h);
      lastQs = h.split('?')[1] || '';
      clearTimeout(timer);
      timer = setTimeout(function () { run(view, 0); }, immediate ? 0 : 250);
    }
    form.addEventListener('input', function (e) { changed(e.target.tagName === 'SELECT'); });
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { changed(true); e.target.blur(); }
      if (e.key === 'Escape') { e.target.blur(); e.stopPropagation(); }
    });
    if (!view._searchBound) {
      view._searchBound = true;
      view.addEventListener('click', function (e) {
        if (view.getAttribute('data-view') !== 'search') return;
        if (e.target.closest('[data-more]')) run(view, lastPage + 1);
        if (e.target.closest('[data-retry-search]')) run(view, 0);
      });
    }
    if (back && qs === lastQs && !searching() && (results.length || statusHTML)) {
      // Coming back: show the same results instantly, at the same place, same row selected.
      restoreY = back.y || 0;
      setStatus(view, statusHTML);
      paintResults(view, false);
      return;
    }
    lastQs = qs;
    restoreY = back ? back.y || 0 : null;
    run(view, 0);
    if (!back) focus(view);
  }

  function focus(view) {
    var input = view.querySelector('.search-input');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  // A search still "Searching…" when you left was cancelled; coming back runs it again
  // instead of restoring a spinner that would never finish.
  function searching() { return /Searching…/.test(statusHTML); }

  g.Search = {
    render: render, focus: focus,
    leave: function () { clearTimeout(timer); token++; if (searching()) statusHTML = ''; }
  };
})(window);
