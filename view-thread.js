/* ==== VIEW: comments page ====
   Primary: whole tree from Algolia in one request (cached; refreshed quietly, keeping open
   replies and scroll). Fallback: official API, one level of replies at a time.
   Adds: new-comment highlights since last visit, "22 replies · 168 total" counts, auto-open of
   threads with new comments, newest-first order, parent pop-up, keyboard navigation. */
(function (g) {
  'use strict';

  var esc = U.esc, HN_WEB = 'https://news.ycombinator.com/', FRESH_MS = 60000;
  var token = 0, cur = null;

  /* ---------- Small HTML pieces ---------- */
  function userLink(by) { return '<a class="by" href="#/user/' + encodeURIComponent(by) + '">' + esc(by) + '</a>'; }
  function backHTML(b) { return b ? '<a class="back" href="' + b.href + '">← ' + esc(b.label) + '</a>' : ''; }

  function headerHTML(h, c) {
    var url = h.url && /^https?:\/\//i.test(h.url) ? h.url : '';
    var dom = U.hnInternal(url) ? '' : U.domainOf(url);
    var meta = [];
    if (h.type !== 'job') meta.push(U.plural(h.score || 0, 'point'));
    if (h.by) meta.push('by ' + userLink(h.by));
    meta.push('<span title="' + esc(U.fullDate(h.time)) + '">' + esc(U.timeAgo(h.time)) + '</span>');
    if (h.type !== 'job') meta.push(U.plural(h.descendants || 0, 'comment'));
    if (Views.heated(h)) meta.push('<span class="tag heated" title="More comments than points">heated</span>');
    meta.push('<a href="' + HN_WEB + 'item?id=' + h.id + '" target="_blank" rel="noopener">HN ↗</a>');
    var title = esc(h.title || 'Untitled');
    var saved = Store.isSaved(h.id);
    return backHTML(c.back) +
      '<header class="item-head">' +
        '<h1 class="item-title">' + (url ? '<a ' + U.linkAttrs(url) + ' data-open-article>' + title + '</a>' : title) +
          (dom ? '<span class="domain">(' + esc(dom) + ')</span>' : '') + '</h1>' +
        '<div class="meta">' + meta.join('<span class="sep">·</span>') + '</div>' +
        '<div class="item-actions">' +
          '<button type="button" class="act save' + (saved ? ' on' : '') + '" data-save="' + h.id + '" aria-pressed="' + saved + '">' +
            '<span class="star">' + (saved ? '★' : '☆') + '</span> ' + (saved ? 'Saved' : 'Save') + '</button>' +
          (c.split ? '' : (url ? '<a class="act" href="#/split/' + h.id + '" title="Article and comments side by side (v)">Side by side</a>' +
            '<a class="act" href="#/read/' + h.id + '" title="Reader view">Reader</a>' : '')) +
          '<span class="seg" role="group" aria-label="Comment order">' +
            '<button type="button" data-order="top" aria-pressed="' + (c.order !== 'new') + '">Top</button>' +
            '<button type="button" data-order="new" aria-pressed="' + (c.order === 'new') + '">Newest</button></span>' +
        '</div>' +
        (h.text ? '<div class="item-text rich">' + U.richHTML(h.text) + '</div>' : '') +
      '</header>';
  }

  function skeletonHTML(back) {
    var h = '';
    for (var i = 0; i < 4; i++) h += '<div class="comment"><div class="skel" style="width:22%;margin-bottom:9px"></div>' +
      '<div class="skel" style="width:96%;margin-bottom:6px"></div><div class="skel" style="width:78%"></div></div>';
    return backHTML(back) + '<header class="item-head"><div class="skel t" style="width:70%;height:22px"></div>' +
      '<div class="skel s"></div></header><div class="comments">' + h + '</div>';
  }

  function unavailableHTML(id, back) {
    return backHTML(back) + '<div class="empty"><h2>This item isn’t available</h2><p>It was deleted, flagged, or never existed. ' +
      '<a href="' + HN_WEB + 'item?id=' + encodeURIComponent(id) + '" target="_blank" rel="noopener">Check on HN ↗</a></p></div>';
  }

  /* ---------- Normalized nodes ---------- */
  function fromOfficial(c) {
    return { id: c.id, by: c.by, time: c.time, text: c.text || '', deleted: !!c.deleted, dead: !!c.dead,
      children: null, kidIds: c.kids || [], parentId: c.parent };
  }
  function gone(n) { return n.deleted || n.dead; }
  function showable(n) {
    if (!gone(n)) return true;
    return n.children ? n.children.some(showable) : n.kidIds.length > 0;
  }

  // Per-subtree totals and new counts, plus an id -> node map for parent pop-ups.
  function annotate(n, ctx) {
    var total = 0, fresh = 0;
    (n.children || []).forEach(function (k) {
      ctx.byId.set(k.id, k);
      annotate(k, ctx);
      k._isNew = !!ctx.prevMax && k.id > ctx.prevMax && !gone(k);
      if (!gone(k)) total++;
      if (k._isNew) fresh++;
      total += k._total; fresh += k._new;
      if (k.id > ctx.maxId) ctx.maxId = k.id;
    });
    n._total = total; n._new = fresh;
  }

  function ordered(parentId, nodes, ctx) {
    var list = nodes.filter(showable);
    if (ctx.order === 'new') return list.sort(function (a, b) { return (b.time || 0) - (a.time || 0) || b.id - a.id; });
    var off = HN.peekItem(parentId);
    if (off && Array.isArray(off.kids)) {
      var pos = new Map(off.kids.map(function (id, i) { return [id, i]; }));
      return list.sort(function (a, b) {
        return (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9) || a.time - b.time;
      });
    }
    return list.sort(function (a, b) { return (a.time || 0) - (b.time || 0); });
  }

  // HN's order for a reply level, waiting at most 250 ms.
  function waitOrder(id, ctx) {
    if (ctx.order === 'new' || HN.peekItem(id)) return Promise.resolve();
    return Promise.race([HN.getItem(id, Infinity).catch(function () {}), U.timeout(250)]);
  }

  /* ---------- Comment element ---------- */
  function commentEl(n, depth, ctx) {
    var el = document.createElement('div');
    el.className = 'comment' + (n._isNew ? ' is-new' : '');
    el.id = 'c' + n.id;
    el.setAttribute('data-id', n.id);
    el.setAttribute('data-depth', depth);
    el.innerHTML = gone(n)
      ? '<div class="c-gone">' + (n.dead ? '[flagged]' : '[deleted]') + '</div>'
      : '<div class="c-meta">' + userLink(n.by || 'unknown') +
          (ctx.opBy && n.by === ctx.opBy ? '<span class="op">OP</span>' : '') +
          (n._isNew ? '<span class="tag new">new</span>' : '') +
          '<a class="t" href="#/item/' + ctx.storyId + '/' + n.id + '" title="' + esc(U.fullDate(n.time)) + '">' + esc(U.timeAgo(n.time)) + '</a>' +
          (depth > 0 ? '<button type="button" class="peek-btn" data-peek title="Show parent (a)">↑ parent</button>' : '') +
        '</div><div class="rich">' + U.richHTML(n.text) + '</div>';

    var kids = n.children ? n.children.filter(showable) : null;
    var count = kids ? kids.length : n.kidIds.length;
    if (!count) return el;

    var color = 'd' + (depth % 8);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'replies-btn ' + color;
    btn.setAttribute('aria-expanded', 'false');
    var box = document.createElement('div');
    box.className = 'children ' + color;
    box.hidden = true;
    // "22 replies" = direct replies; the whole-thread total shows faded only when it's bigger.
    function label(k) {
      var more = kids && n._total > k ? '<span class="rtotal"> · ' + n._total + ' total</span>' : '';
      btn.innerHTML = '<span class="chev">▶</span>' + U.plural(k, 'reply', 'replies') + more +
        (n._new ? '<span class="tag new">' + n._new + ' new</span>' : '');
    }
    label(count);

    var loaded = false, loading = null;
    function show(animate) {
      btn.setAttribute('aria-expanded', 'true');
      el.setAttribute('data-open', 'true');
      if (animate) Anim.expand(box); else box.hidden = false;
    }
    function hide() {
      btn.setAttribute('aria-expanded', 'false');
      el.removeAttribute('data-open');
      Anim.collapse(box);
    }
    el._open = function (instant) {
      if (loaded) { show(!instant); return Promise.resolve(); }
      if (loading) return loading;
      btn.setAttribute('aria-busy', 'true');
      loading = kids
        ? (instant ? Promise.resolve() : waitOrder(n.id, ctx)).then(function () { renderNodes(box, ordered(n.id, kids, ctx), depth + 1, ctx); })
        : (show(false), loadIds(box, n.kidIds, depth + 1, ctx).then(function (v) {
            if (!v) { btn.disabled = true; btn.textContent = 'Replies were deleted'; } else label(v);
          }));
      return loading.then(function () {
        loaded = true; loading = null;
        btn.removeAttribute('aria-busy');
        if (btn.disabled) { box.hidden = true; return; }
        show(!instant && !!kids);
      });
    };
    el._toggle = function () { return btn.getAttribute('aria-expanded') === 'true' ? (hide(), Promise.resolve()) : el._open(false); };
    btn.addEventListener('click', function () { el._toggle(); });
    el.appendChild(btn);
    el.appendChild(box);
    if (ctx.autoOpen && n._new) el._open(true);
    return el;
  }

  function renderNodes(container, nodes, depth, ctx) {
    container.innerHTML = '';
    var thread = document.createElement('div');
    thread.className = 'thread';
    nodes.forEach(function (n) { thread.appendChild(commentEl(n, depth, ctx)); });
    container.appendChild(thread);
  }

  /* Official-API mode: fetch ids into ordered slots; resolves with the visible count. */
  function loadIds(container, ids, depth, ctx) {
    container.innerHTML = '<div class="thread"></div><div class="inline-note">Loading ' + U.plural(ids.length, 'comment') + '…</div>';
    var thread = container.firstChild, visible = 0;
    var slots = ids.map(function () { return thread.appendChild(document.createElement('div')); });
    function fill(id, i) {
      if (!Nav.alive(ctx.navId)) return;   // page left: don't start more requests
      return HN.getItem(id, 120000, ctx.signal).then(function (c) {
        if (!Nav.alive(ctx.navId)) return;
        if (!c || (HN.isGone(c) && !(c.kids && c.kids.length))) { slots[i].remove(); return; }
        visible++;
        var n = fromOfficial(c);
        n._isNew = !!ctx.prevMax && n.id > ctx.prevMax && !gone(n);
        ctx.byId.set(n.id, n);
        var el = commentEl(n, depth, ctx);
        slots[i].replaceWith(el); slots[i] = el;
      }, function (e) {
        if (!Nav.alive(ctx.navId) || HN.isAbort(e)) return;
        visible++;
        slots[i].innerHTML = '<div class="comment"><div class="c-gone">Couldn’t load this comment. <button type="button" class="linkbtn">Retry</button></div></div>';
        slots[i].querySelector('button').onclick = function () { visible--; slots[i].innerHTML = '<div class="inline-note">Retrying…</div>'; fill(id, i); };
      });
    }
    // The "Loading…" note is removed however this ends (done, failed, or page left).
    return U.pool(ids, 16, fill).then(function () {
      var note = container.querySelector(':scope > .inline-note');
      if (note) note.remove();
      return visible;
    });
  }

  /* ---------- Scrolling (window, or the comments pane in side-by-side) ---------- */
  function scrollBy(ctx, dy) { if (ctx.scroller === window) window.scrollBy(0, dy); else ctx.scroller.scrollTop += dy; }
  function scrollTop(ctx) { if (ctx.scroller === window) window.scrollTo(0, 0); else ctx.scroller.scrollTop = 0; }

  function captureState() {
    var open = Array.prototype.map.call(cur.view.querySelectorAll('.comment[data-open="true"]'), function (el) { return el.id; });
    var anchor = null, els = cur.view.querySelectorAll('.comment');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.bottom > 80) { anchor = { id: els[i].id, top: r.top }; break; }
    }
    var sel = cur.view.querySelector('.comment.sel');
    return { open: open, anchor: anchor, sel: sel && sel.id };
  }

  function restoreState(st, ctx) {
    return openIds(st.open).then(function () {
      var a = st.anchor && document.getElementById(st.anchor.id);
      if (a) scrollBy(ctx, a.getBoundingClientRect().top - st.anchor.top);
      var s = st.sel && document.getElementById(st.sel);
      if (s) s.classList.add('sel');
    });
  }

  function openIds(ids) {
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        var el = document.getElementById(String(id).charAt(0) === 'c' ? id : 'c' + id);
        if (el && el._open && el.getAttribute('data-open') !== 'true') return el._open(true);
      });
    });
    return chain;
  }

  /* ---------- Focusing a linked comment ---------- */
  function findPath(node, id, path) {
    for (var i = 0; i < node.children.length; i++) {
      var k = node.children[i];
      if (k.id === id) return path;
      var p = findPath(k, id, path.concat(k.id));
      if (p) return p;
    }
    return null;
  }

  function focusComment(id) {
    var el = document.getElementById('c' + id);
    if (!el) return false;
    select(el, 'center');
    Anim.replay(el, 'pulse');
    return true;
  }

  function noteMissing(id) {
    var c = cur.view.querySelector('#comments');
    if (!c || c.querySelector('.focus-missing')) return;
    c.insertAdjacentHTML('afterbegin', '<div class="inline-note focus-missing">That comment isn’t in this thread yet (too new, or deleted). ' +
      '<a href="' + HN_WEB + 'item?id=' + id + '" target="_blank" rel="noopener">Open it on HN ↗</a></div>');
  }

  /* ---------- Rendering ---------- */
  function headerData(root) {
    var o = HN.peekItem(cur.storyId);
    o = o && !HN.isGone(o) ? o : null;
    return {
      id: cur.storyId, type: (o && o.type) || root.type, title: (o && o.title) || root.title,
      url: o ? o.url : root.url, score: o && o.score != null ? o.score : root.score, by: (o && o.by) || root.by,
      time: (o && o.time) || root.time, text: (o && o.text) || root.text,
      descendants: o && o.descendants != null ? o.descendants : root._total
    };
  }

  function newCtx() {
    return { storyId: cur.storyId, prevMax: cur.prevMax, order: Store.pref('order'), autoOpen: Store.pref('autoOpen'),
      navId: cur.navId, signal: cur.signal,
      byId: new Map(), maxId: 0, scroller: cur.scroller, back: cur.back, split: cur.split, opBy: null };
  }

  function commentsHead(topCount, total, fresh, ctx) {
    return '<div class="comments-head">' + U.plural(topCount, 'top-level comment') + (total != null ? ' · ' + total + ' total' : '') +
      (fresh ? ' · <button type="button" class="linkbtn new-link" data-next-new>' + fresh + ' new since your last visit</button>' : '') +
      (ctx.order === 'new' ? ' · newest first' : '') + '</div>';
  }

  function showTree(my, root, quiet) {
    if (stale(my)) return;
    var off = HN.peekItem(cur.storyId);
    if (off && off.deleted) { cur.view.innerHTML = unavailableHTML(cur.storyId, cur.back); cur.shown = true; return; }
    var st = quiet ? captureState() : null;
    var ctx = newCtx();
    annotate(root, ctx);
    var h = headerData(root);
    ctx.opBy = h.by;
    cur.mode = 'tree'; cur.root = root; cur.ctx = ctx; cur.h = h;
    var top = ordered(cur.storyId, root.children, ctx);
    cur.view.innerHTML = headerHTML(h, ctx) + '<section class="comments" id="comments">' +
      (top.length ? commentsHead(top.length, root._total, root._new, ctx)
        : '<div class="empty"><p>' + (h.type === 'job' ? 'Job posts don’t have comments.' : 'No comments yet.') + '</p></div>') +
      '</section>';
    if (!cur.split) document.title = (h.title || 'Comments') + ' · The Hundred';
    if (top.length) {
      var box = document.createElement('div');
      box.className = 'top-thread';
      cur.view.querySelector('#comments').appendChild(box);
      renderNodes(box, top, 0, ctx);
    }
    if (st) restoreState(st, ctx);
    else if (!cur.shown) scrollTop(ctx);
    cur.shown = true;
    Store.markSeen(cur.storyId, ctx.maxId, h.descendants);
    Nav.done(cur.navId, 'thread ' + cur.storyId + (quiet ? ' (refreshed)' : ''));
    if (!cur.learned) { cur.learned = true; Store.learn(h, 1); }
    if (cur.focus) {
      var path = findPath(root, cur.focus, []);
      if (path) {
        var f = cur.focus; cur.focus = null;
        openIds(path).then(function () { if (!stale(my)) focusComment(f); });
      } else if (cur.refreshed) noteMissing(cur.focus);
    }
  }

  function showOfficial(my) {
    return HN.getItem(cur.storyId, 60000, cur.signal).then(function (it) {
      if (stale(my)) return;
      if (!it || HN.isGone(it)) { cur.view.innerHTML = unavailableHTML(cur.storyId, cur.back); return; }
      if (it.type === 'comment') return redirectComment(my, it.id);
      var kids = it.kids || [], ctx = newCtx();
      ctx.opBy = it.by;
      var h = headerData({ type: it.type });
      cur.mode = 'official'; cur.ctx = ctx; cur.h = h;
      cur.view.innerHTML = headerHTML(h, ctx) + '<section class="comments" id="comments">' +
        (kids.length ? commentsHead(kids.length, it.descendants, 0, ctx)
          : '<div class="empty"><p>' + (it.type === 'job' ? 'Job posts don’t have comments.' : 'No comments yet.') + '</p></div>') + '</section>';
      cur.shown = true;
      Store.markSeen(it.id, Math.max.apply(null, [0].concat(kids)), it.descendants);
      Nav.done(cur.navId, 'thread ' + it.id + ' (official API)');
      if (!cur.learned) { cur.learned = true; Store.learn(h, 1); }
      if (!kids.length) return;
      var box = document.createElement('div');
      box.className = 'top-thread';
      cur.view.querySelector('#comments').appendChild(box);
      var ids = ctx.order === 'new' ? kids.slice().sort(function (a, b) { return b - a; }) : kids;
      var loaded = loadIds(box, ids, 0, ctx);
      if (cur.focus) {
        var f = cur.focus;
        Promise.all([loaded, parentChain(f)]).then(function (r) {
          if (stale(my)) return;
          var chain = r[1];
          if (!chain || chain[0] !== it.id) return noteMissing(f);
          return openIds(chain.slice(1, -1)).then(function () { if (!focusComment(f)) noteMissing(f); });
        });
      }
    });
  }

  function parentChain(id) {
    var chain = [id], navId = cur.navId, signal = cur.signal;
    function step(cid, hops) {
      if (hops > 80 || !Nav.alive(navId)) return null;   // stop walking once the page is left
      return HN.getItem(cid, Infinity, signal).then(function (it) {
        if (!it) return null;
        if (it.type !== 'comment' || !it.parent) return chain;
        chain.unshift(it.parent);
        return step(it.parent, hops + 1);
      });
    }
    return Promise.resolve(step(id, 0)).catch(function () { return null; });
  }

  function redirectComment(my, cid) {
    var sid = Thread.storyOf(cid);
    if (sid) return Promise.resolve(App.go('#/item/' + sid + '/' + cid, true));
    return parentChain(cid).then(function (chain) {
      if (stale(my)) return;
      if (chain && chain[0] !== cid) App.go('#/item/' + chain[0] + '/' + cid, true);
      else cur.view.innerHTML = unavailableHTML(cid, cur.back);
    });
  }

  /* opts: { back, scroller, split, nav: { id, signal } } */
  function render(id, focus, view, opts) {
    var my = ++token;
    var nav = opts.nav || { id: Nav.id, signal: null };
    cur = { storyId: id, focus: focus || null, view: view, back: opts.back, scroller: opts.scroller || window,
      split: !!opts.split, shown: false, refreshed: false, learned: false, opened: Date.now(),
      navId: nav.id, signal: nav.signal };
    var s = Store.seen(id);
    cur.prevMax = s && s.m;

    if (!focus) {
      var sid = Thread.storyOf(id), offc = HN.peekItem(id);
      if (sid) return App.go('#/item/' + sid + '/' + id, true);
      if (offc && offc.type === 'comment') return redirectComment(my, id);
    }

    var entry = Thread.peek(id);
    var pending = !(entry && Date.now() - entry.t < FRESH_MS && entry.node.type !== 'comment');
    // The "updating…" indicator always clears, whether the refresh lands, fails, or is cancelled.
    var busy = false;
    function setBusy(on) { if (on !== busy) { busy = on; App.busy(on ? 1 : -1); } }

    if (entry && entry.node.type !== 'comment') showTree(my, entry.node, false);
    else {
      view.innerHTML = skeletonHTML(opts.back);
      Thread.cached(id).then(function (e) {
        if (!stale(my) && e && !cur.shown && e.node.type !== 'comment') { showTree(my, e.node, false); if (pending) setBusy(true); }
      });
    }
    if (!pending) { cur.refreshed = true; return; }
    if (cur.shown) setBusy(true);

    var official = Promise.race([HN.getItem(id, 60000, nav.signal).catch(function () { return null; }), U.timeout(1500)]);
    Promise.all([Thread.fetch(id, nav.signal), official]).then(function (r) {
      if (stale(my)) return Nav.log('ignored', 'late thread ' + id);
      var node = r[0];
      if (node.type === 'comment') return node.storyId ? App.go('#/item/' + node.storyId + '/' + id, true) : redirectComment(my, id);
      cur.refreshed = true;
      showTree(my, node, cur.shown);
    }, function (e) {
      if (stale(my) || HN.isAbort(e)) return;
      cur.refreshed = true;
      if (cur.shown) { if (cur.focus) noteMissing(cur.focus); return; }
      showOfficial(my).catch(function (e2) {
        if (stale(my) || HN.isAbort(e2)) return;
        Nav.log('error', 'thread ' + id + ': ' + e2.message);
        view.innerHTML = backHTML(opts.back) + App.errorHTML(e2, 'this item');
      });
    }).then(function () { setBusy(false); }, function () { setBusy(false); });
  }

  // A late response belongs to a page that's gone if a newer comments page was opened
  // or the app navigated anywhere else since.
  function stale(my) { return my !== token || !cur || !Nav.alive(cur.navId); }

  function rerender() {
    if (cur && cur.mode === 'tree' && cur.root && !stale(token)) { showTree(token, cur.root, true); return true; }
    return false;
  }

  /* ---------- Parent pop-up (Hacki's "ancestor lookup") ---------- */
  function togglePeek(el) {
    var open = el.querySelector(':scope > .peek');
    if (open) { open.remove(); return; }
    document.querySelectorAll('.peek').forEach(function (p) { p.remove(); });
    var parentEl = el.parentElement && el.parentElement.closest('.comment');
    var pid = parentEl ? Number(parentEl.getAttribute('data-id')) : null;
    var n = pid && cur.ctx.byId.get(pid);
    if (!n) return;
    var box = document.createElement('div');
    box.className = 'peek';
    box.innerHTML = '<div class="c-meta">' + (gone(n) ? '[deleted]' : userLink(n.by || 'unknown') + '<span>' + esc(U.timeAgo(n.time)) + '</span>') +
      '<button type="button" class="linkbtn" data-jump="' + pid + '">jump to parent</button></div>' +
      '<div class="rich">' + U.richHTML(n.text) + '</div>';
    el.querySelector('.c-meta').after(box);
  }

  /* ---------- Selection + keyboard (idea 5: Circumflex / Materialistic) ---------- */
  function visibleComments() {
    return Array.prototype.filter.call(cur.view.querySelectorAll('.comment'), function (el) { return el.offsetParent !== null; });
  }
  function select(el, block) {
    if (!el) return;
    var old = cur.view.querySelector('.comment.sel');
    if (old) old.classList.remove('sel');
    el.classList.add('sel');
    Anim.reveal(el, block);
  }
  function step(list, dir) {
    var sel = cur.view.querySelector('.comment.sel'), i = list.indexOf(sel);
    if (i < 0) {   // nothing selected: start from the first one on screen
      i = list.findIndex(function (el) { return el.getBoundingClientRect().top > 60; });
      return select(list[Math.max(0, dir > 0 ? i : i - 1)] || list[0]);
    }
    select(list[Math.min(list.length - 1, Math.max(0, i + dir))]);
  }

  function key(k) {
    if (!cur || !cur.shown) return false;
    var sel = cur.view.querySelector('.comment.sel');
    switch (k) {
      case 'j': step(visibleComments(), 1); return true;
      case 'k': step(visibleComments(), -1); return true;
      case 'n': case 'p': {
        var tops = Array.prototype.slice.call(cur.view.querySelectorAll('.top-thread > .thread > .comment'));
        var top = sel && (sel.closest('.top-thread > .thread > .comment'));
        if (!sel) { step(tops, k === 'n' ? 1 : -1); return true; }
        var i = tops.indexOf(top) + (k === 'n' ? 1 : (top === sel ? -1 : 0));
        select(tops[Math.max(0, Math.min(tops.length - 1, i))]);
        return true;
      }
      case 'l': case 'ArrowRight':
        if (sel && sel._open) sel._open(false).then(function () {
          var first = sel.querySelector(':scope > .children > .thread > .comment');
          if (first) select(first);
        });
        return true;
      case 'h': case 'ArrowLeft': {
        var parent = sel && sel.parentElement.closest('.comment');
        if (parent) select(parent);
        return true;
      }
      case 'r': if (sel && sel._toggle) sel._toggle(); return true;
      case 'a': if (sel) togglePeek(sel); return true;
      case 'u': nextNew(); return true;
    }
    return false;
  }

  function nextNew() {
    var list = Array.prototype.slice.call(cur.view.querySelectorAll('.comment.is-new')).filter(function (el) { return el.offsetParent !== null; });
    if (!list.length) return App.toast('No new comments to jump to');
    var sel = cur.view.querySelector('.comment.sel');
    var next = list.find(function (el) { return sel && (sel.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING); }) || list[0];
    select(next, 'center');
    Anim.replay(next, 'pulse');
  }

  /* Delegated clicks inside the comments page. */
  function click(e) {
    var t = e.target.closest('[data-peek],[data-jump],[data-order],[data-next-new]');
    if (!t || !cur) return false;
    if (t.hasAttribute('data-peek')) togglePeek(t.closest('.comment'));
    else if (t.hasAttribute('data-jump')) { var p = document.getElementById('c' + t.getAttribute('data-jump')); t.closest('.peek').remove(); if (p) { select(p, 'center'); Anim.replay(p, 'pulse'); } }
    else if (t.hasAttribute('data-next-new')) nextNew();
    else if (t.hasAttribute('data-order')) {
      Store.setPref('order', t.getAttribute('data-order'));
      if (!rerender()) App.reroute();
    }
    return true;
  }

  g.Comments = {
    render: render, rerender: rerender, key: key, click: click,
    current: function () { return cur && cur.h ? { story: cur.h, opened: cur.opened } : null; }
  };
})(window);
