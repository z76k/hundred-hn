/* ==== VIEWS: story lists (source tabs, For You, Saved) ====
   Rows show read fade, "N new" comment badges, followed-topic highlight, heated marker,
   save star. New rows animate in (staggered on first paint); re-renders never re-animate. */
(function (g) {
  'use strict';

  var esc = U.esc;
  var rowData = new Map();          // id -> story, for actions on what's on screen
  var renderedIds = {}, selId = {};   // per list: ids already shown (animate once), selected story
  var prefetched = new Set();

  function heated(st) { return (st.score || 0) >= 10 && (st.descendants || 0) > (st.score || 0); }

  function rowHTML(st, i, o) {
    o = o || {};
    rowData.set(st.id, st);
    var url = st.url && /^https?:\/\//i.test(st.url) ? st.url : '';
    var item = '#/item/' + st.id, dom = U.hnInternal(url) ? '' : U.domainOf(url);
    var isJob = st.type === 'job' || o.tab === 'jobs';
    var read = Store.isRead(st.id), fresh = read ? Store.newCount(st) : 0;
    var topics = Store.topicMatches(st), saved = Store.isSaved(st.id), isNew = o.tab && Lists.isNew(o.tab, st.id);
    var enter = o.enter ? ' enter" style="--i:' + o.enter : '';
    var meta = [];
    if (!isJob) meta.push(U.plural(st.score || 0, 'point'));
    if (st.by) meta.push('by <a href="#/user/' + encodeURIComponent(st.by) + '">' + esc(st.by) + '</a>');
    meta.push('<a href="' + item + '" title="' + esc(U.fullDate(st.time)) + '">' + esc(U.timeAgo(st.time)) + '</a>');
    if (heated(st)) meta.push('<span class="tag heated" title="More comments than points">heated</span>');
    if (o.why && st._why && st._why.length) meta.push('<span class="why">for you: ' + esc(st._why.join(', ')) + '</span>');
    return '<li class="story' + (read ? ' is-read' : '') + (isNew ? ' is-new' : '') + (topics.length ? ' topic' : '') +
        enter + '" data-id="' + st.id + '">' +
      '<span class="rank"' + (st.hnRank ? ' title="Hacker News rank #' + st.hnRank + '"' : '') + '>' + (i + 1) + '</span>' +
      '<div class="story-main"><h3 class="title-line">' + (isNew ? '<span class="new-pill">new</span>' : '') +
        '<a ' + (url ? U.linkAttrs(url) : 'href="' + item + '"') + ' data-open-article>' + esc(st.title || 'Untitled') + '</a>' +
        (dom ? '<span class="domain">(' + esc(dom) + ')</span>' : '') +
        topics.map(function (t) { return '<span class="tag topic-tag">' + esc(t) + '</span>'; }).join('') + '</h3>' +
        '<div class="meta">' + meta.join('<span class="sep">·</span>') + '</div></div>' +
      '<div class="row-right">' +
        '<button type="button" class="save-btn' + (saved ? ' on' : '') + '" data-save="' + st.id + '" aria-pressed="' + saved +
          '" title="' + (saved ? 'Saved' : 'Save for later') + ' (s)">' + (saved ? '★' : '☆') + '</button>' +
        (isJob ? '<span class="cmt"></span>' :
          '<a class="cmt" href="' + item + '" aria-label="' + (st.descendants || 0) + ' comments"><span class="cmt-n">' + (st.descendants || 0) +
          '</span><span class="cmt-l">' + (fresh ? '<b class="newc">' + fresh + ' new</b>' : 'comments') + '</span></a>') +
      '</div></li>';
  }

  function skeleton(n) {
    var h = '';
    for (var i = 0; i < n; i++) h += '<div class="skel-row" aria-hidden="true"><div class="skel"></div><div><div class="skel t" style="width:' +
      (55 + (i * 37) % 40) + '%"></div><div class="skel s"></div></div><div class="skel" style="height:18px"></div></div>';
    return h;
  }

  function ago(ms) {
    var s = Math.floor((Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    return m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
  }

  /* Shared list frame: status line + rows + footer.
     Rows are keyed by story id and patched in place: an unchanged row is never touched, a changed
     row keeps its element (so hover and transitions don't reset), and only a row appearing for the
     first time in a list animates in. Returning to a list or a background refresh never re-animates. */
  var ROW_RE = /^<li class="([^"]*)" data-id="\d+">([\s\S]*)<\/li>$/;
  var RANK_RE = /^<span class="rank"[^>]*>\d+<\/span>/;

  function setHTML(el, html) { if (el._html !== html) { el._html = html; el.innerHTML = html; } }

  function frame(view, key, statusHTML, stories, opts) {
    if (view.getAttribute('data-view') !== key) {
      view.setAttribute('data-view', key);
      view.innerHTML = '<div class="status" role="status"></div><div class="list-body"><div class="list-intro"></div>' +
        '<div class="list-msg"></div><ol class="list"></ol><div class="list-tail"></div></div>' +
        '<p class="foot">Live from the <a href="https://github.com/HackerNews/API" target="_blank" rel="noopener">official HN API</a> and ' +
        '<a href="https://hn.algolia.com/api" target="_blank" rel="noopener">HN Search by Algolia</a>. Read only.<span class="kb-only"> Press <kbd>?</kbd> for shortcuts.</span></p>';
    }
    var seen = renderedIds[key] || (renderedIds[key] = new Set());
    setHTML(view.querySelector('.status'), statusHTML);
    setHTML(view.querySelector('.list-intro'), opts.intro || '');
    setHTML(view.querySelector('.list-msg'), opts.html || '');
    setHTML(view.querySelector('.list-tail'), opts.html == null ? opts.tail || '' : '');
    patchRows(view.querySelector('.list'), key, opts.html == null ? stories : [], opts, seen);
    if (opts.html == null) idlePrefetch(stories);
  }

  function patchRows(ol, key, stories, opts, seen) {
    var existing = new Map(), first = seen.size === 0, k = 0, prev = null;
    Array.prototype.forEach.call(ol.children, function (li) { existing.set(Number(li.getAttribute('data-id')), li); });
    stories.forEach(function (st, i) {
      var m = ROW_RE.exec(rowHTML(st, i, { tab: opts.tab, why: opts.why }));
      var cls = m[1], inner = m[2], sig = inner.replace(RANK_RE, '');
      var li = existing.get(st.id);
      if (li) existing.delete(st.id);
      else {
        li = document.createElement('li');
        li.setAttribute('data-id', st.id);
        if (!seen.has(st.id)) {
          li._enter = true;
          li.style.setProperty('--i', first ? Math.min(++k, 14) : 1);
          setTimeout(function () { li._enter = false; li.classList.remove('enter'); }, 1400);
        }
      }
      seen.add(st.id);
      if (li._sig !== sig) { li.innerHTML = inner; li._sig = sig; }
      else {
        var r = li.firstElementChild;
        if (r.textContent !== String(i + 1)) r.textContent = String(i + 1);
        if (st.hnRank && r.title !== 'Hacker News rank #' + st.hnRank) r.title = 'Hacker News rank #' + st.hnRank;
      }
      var want = cls + (li._enter ? ' enter' : '') + (selId[key] === st.id ? ' sel' : '');
      if (li.className !== want) li.className = want;
      var at = prev ? prev.nextElementSibling : ol.firstElementChild;
      if (at !== li) ol.insertBefore(li, at);
      prev = li;
    });
    existing.forEach(function (li) { li.remove(); });
  }

  // Idea 8: in idle time, fetch threads for the top few unread stories on screen.
  function idlePrefetch(stories) {
    (window.requestIdleCallback || setTimeout)(function () {
      stories.filter(function (s) { return !Store.isRead(s.id) && !prefetched.has(s.id) && s.type !== 'job'; }).slice(0, 3)
        .forEach(function (s) { prefetched.add(s.id); Thread.prefetch(s.id); });
    }, { timeout: 3000 });
  }

  /* ---------- Source tabs (Top, Best, New, Ask, Show, Jobs) ---------- */
  function phaseText(s, label) {
    var p = s.total ? ' ' + s.scanned + ' / ' + s.total : '';
    if (s.phase === 'verify') return 'confirming live comment counts…' + p;
    if (s.phase === 'scan') return 'scanning ' + label + '…' + p;
    if (s.phase === 'algolia') return 'finding stories with ' + Lists.MIN + '+ comments…';
    return 'loading ' + label + '…';
  }

  function sourceStatus(tab, label) {
    var s = Lists.state[tab], parts = [], dot = 'dot';
    var summary = tab === 'jobs' ? s.stories.length + ' job posts'
      : s.stories.length + (s.listSize ? ' of ' + s.listSize : '') + ' ' + label + ' stories have ' + Lists.MIN + '+ comments';
    if (s.status === 'loading' && s.snapshotAt) { dot += ' busy'; parts.push('Saved list from ' + ago(s.snapshotAt), 'updating… ' + phaseText(s, label)); }
    else if (s.status === 'loading') { dot += ' busy'; var t = phaseText(s, label); parts.push(s.painted ? summary + ' · ' + t : t[0].toUpperCase() + t.slice(1)); }
    else if (s.status === 'refreshing') { dot += ' busy'; parts.push(summary, 'updating… ' + phaseText(s, label)); }
    else if (s.status === 'stale') { dot += ' err'; parts.push('Couldn’t reach Hacker News · showing saved list from ' + ago(s.snapshotAt)); }
    else if (s.status === 'ready') {
      if (s.refreshError) dot += ' err';
      parts.push(summary, (s.refreshError ? 'last check failed · list from ' : 'updated ') + ago(s.loadedAt));
      var next = Lists.nextCheckAt() - Date.now();
      if (next > 0) parts.push('next check ~' + Math.max(1, Math.round(next / 60000)) + 'm');
      if (s.failed) parts.push(s.failed + ' couldn’t load');
      if (s.via === 'official' && tab !== 'jobs') parts.push('search index unavailable, used the slower path');
    }
    return '<span class="' + dot + '"></span><span>' + parts.join(' · ') + '</span><span class="spacer"></span>' +
      (s.status === 'ready' || s.status === 'stale' ? '<button type="button" class="linkbtn" data-refresh>Check now</button>' : '');
  }

  function renderSource(view, tab, label) {
    var s = Lists.state[tab], html = null;
    if (s.status === 'error' && !s.stories.length) html = App.errorHTML(s.error, 'the ' + label + ' list');
    else if (!s.stories.length && (s.status === 'loading' || s.status === 'idle')) html = skeleton(14);
    else if (!s.stories.length) html = '<div class="empty"><h2>Nothing here clears ' + Lists.MIN + ' comments right now</h2><p>' +
      (tab === 'new' ? 'New stories rarely have 100 comments yet. They’ll appear here, marked “new”, as background checks find them.'
        : 'The list is re-checked every few minutes; stories appear as they cross the line.') + '</p></div>';
    frame(view, tab, sourceStatus(tab, label), s.stories, { html: html, tab: tab,
      tail: s.status === 'loading' && s.phase === 'scan' && !s.snapshotAt && s.scanned < s.total ? skeleton(3) : '' });
  }

  /* ---------- For You ---------- */
  function renderForYou(view) {
    var stories = Lists.forYou(), loading = Lists.anyLoading(['top', 'best', 'ask', 'show']);
    var signals = Store.modelSize(), topics = Store.topics().length;
    var status = '<span class="dot' + (loading ? ' busy' : '') + '"></span><span>' +
      (stories.length ? 'Ranked for you from ' + stories.length + ' stories with ' + Lists.MIN + '+ comments' : 'Gathering stories…') +
      ' · learned from ' + (signals ? signals + ' interests' : 'nothing yet') + (topics ? ' and ' + U.plural(topics, 'followed topic') : '') +
      '</span><span class="spacer"></span><button type="button" class="linkbtn" data-open-settings>Topics &amp; learning</button>';
    var intro = !signals && !topics
      ? '<div class="inline-note intro">For You learns only from what you open, save and spend time on, stored in this browser. Until then it shows popular discussions. Follow topics in Settings to steer it.</div>' : '';
    frame(view, 'foryou', status, stories, {
      html: !stories.length ? (loading ? skeleton(12) : '<div class="empty"><p>No stories loaded yet.</p></div>') : null,
      why: true, tail: '', intro: stories.length ? intro : ''
    });
  }

  /* ---------- Saved ---------- */
  function renderSaved(view) {
    var list = Store.saved();
    Lists.refreshSaved();
    frame(view, 'saved', '<span class="dot"></span><span>' + U.plural(list.length, 'saved story', 'saved stories') +
      ' · kept in this browser · the 100-comment rule doesn’t apply here</span>', list, {
      html: list.length ? null : '<div class="empty"><h2>Nothing saved yet</h2><p>Press <kbd>s</kbd> or the ☆ on any story to keep it here.</p></div>'
    });
  }

  /* ---------- Keyboard on lists (also search results) ---------- */
  function rows(view) { return Array.prototype.slice.call(view.querySelectorAll('.story[data-id]')); }

  // Selection is remembered per list (tab or search) so Back returns to the same story.
  function selectRow(view, el, noScroll) {
    if (!el) return;
    rows(view).forEach(function (r) { if (r !== el) r.classList.remove('sel'); });
    el.classList.add('sel');
    selId[view.getAttribute('data-view')] = Number(el.getAttribute('data-id'));
    if (!noScroll) Anim.reveal(el);
  }

  // Re-apply the remembered selection after a list is drawn (search draws its own rows).
  function applySel(view) {
    var id = selId[view.getAttribute('data-view')];
    rows(view).forEach(function (r) {
      var on = Number(r.getAttribute('data-id')) === id;
      if (r.classList.contains('sel') !== on) r.classList.toggle('sel', on);
    });
  }

  function key(view, k) {
    var list = rows(view);
    if (!list.length) return false;
    var sel = view.querySelector('.story.sel'), i = list.indexOf(sel);
    if (k === 'j' || k === 'k') {
      if (i < 0) i = Math.max(0, list.findIndex(function (r) { return r.getBoundingClientRect().top > 60; })) - (k === 'j' ? 1 : 0);
      selectRow(view, list[Math.max(0, Math.min(list.length - 1, i + (k === 'j' ? 1 : -1)))]);
      return true;
    }
    if (!sel) return false;
    var st = rowData.get(Number(sel.getAttribute('data-id')));
    if (k === 'Enter' || k === 'o') { openArticle(st); return true; }
    if (k === 'c') { App.go('#/item/' + st.id); return true; }
    if (k === 's') { App.toggleSave(st, sel.querySelector('.save-btn')); return true; }
    if (k === 'v') { App.go(st.url ? '#/split/' + st.id : '#/item/' + st.id); return true; }
    return false;
  }

  // Open the article in a new tab (or the comments page for text posts) and record it as read.
  function openArticle(st) {
    if (!st.url || U.hnInternal(st.url)) { App.go(st.url ? U.hnInternal(st.url) : '#/item/' + st.id); return; }
    markOpened(st);
    window.open(st.url, '_blank', 'noopener');
  }
  function markOpened(st) {
    Store.markSeen(st.id, null, st.descendants);
    Store.learn(st, 1);
  }

  g.Views = {
    heated: heated, rowHTML: rowHTML, skeleton: skeleton, renderSource: renderSource, renderForYou: renderForYou,
    renderSaved: renderSaved, key: key, markOpened: markOpened, selectRow: selectRow, applySel: applySel,
    story: function (id) { return rowData.get(id) || HN.peekItem(id) || null; }
  };
})(window);
