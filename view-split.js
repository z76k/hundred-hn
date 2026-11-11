/* ==== VIEW: side by side + reader view (Circumflex's wide view, Materialistic's article pane) ====
   Side by side: article on the left, comments on the right. Many sites refuse to load inside
   another page and the browser can't tell us, so: a best-guess list of sites that block
   embedding, a remembered per-site choice, and Reader view / "open in new tab" one click away.
   Reader view (also on its own at #/read/id) fetches a text version through r.jina.ai.
   Vim-style keys work in Reader view; in side by side, Tab picks which side the keys control. */
(function (g) {
  'use strict';

  var esc = U.esc, token = 0, readerCache = new Map();
  var BLOCKS = /(^|\.)(github\.com|twitter\.com|x\.com|nytimes\.com|wsj\.com|bloomberg\.com|reddit\.com|linkedin\.com|facebook\.com|instagram\.com|google\.com|stackoverflow\.com|stackexchange\.com|ft\.com|economist\.com|washingtonpost\.com|apple\.com|microsoft\.com|amazon\.com)$/;
  // Page on screen: solo = standalone reader; side = which half the keys control in side by side.
  var S = { st: null, view: null, solo: false, mode: 'page', side: 'comments', gAt: 0 };

  function embedURL(url) {
    var m = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([\w-]{6,})/.exec(url);
    return m ? 'https://www.youtube-nocookie.com/embed/' + m[1] : url;
  }

  function barHTML(st, mode) {
    return '<div class="pane-bar"><span class="pane-title" title="' + esc(st.title) + '">' + esc(U.domainOf(st.url)) + '</span>' +
      '<span class="seg" role="group" aria-label="Article view">' +
        '<button type="button" data-mode="page" aria-pressed="' + (mode === 'page') + '">Page</button>' +
        '<button type="button" data-mode="reader" aria-pressed="' + (mode === 'reader') + '">Reader</button></span>' +
      '<a class="act" href="' + esc(st.url) + '" target="_blank" rel="noopener">New tab ↗</a>' +
      '<a class="act" href="#/item/' + st.id + '" title="Back to comments only (v)">Close</a></div>' +
      '<div class="pane-note" hidden>Blank or “refused to connect”? This site blocks embedding. ' +
        '<button type="button" class="linkbtn" data-mode="reader">Use Reader view</button> or open it in a new tab.</div>' +
      '<div class="pane-body"></div>';
  }

  function showPage(pane, st, my) {
    var body = pane.querySelector('.pane-body'), note = pane.querySelector('.pane-note');
    body.innerHTML = '<iframe title="' + esc(st.title) + '" src="' + esc(embedURL(st.url)) + '" referrerpolicy="no-referrer" ' +
      'sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox"></iframe>';
    note.hidden = false;
    note.classList.remove('loud');
    var loaded = false;
    body.firstChild.addEventListener('load', function () { loaded = true; });
    setTimeout(function () { if (live(my) && !loaded) note.classList.add('loud'); }, 8000);
  }

  // Reader text into `body` (side-by-side pane body, or the standalone reader page).
  // Leaving cancels the download; text that already arrived stays cached for next time.
  function showReader(body, st, my) {
    body.innerHTML = '<div class="reader"><div class="skel t" style="width:60%"></div><div class="skel" style="width:95%;margin:10px 0"></div>' +
      '<div class="skel" style="width:88%"></div></div>';
    var p = readerCache.get(st.url) || fetch('https://r.jina.ai/' + st.url, { signal: S.signal || undefined }).then(function (r) {
      if (!r.ok) throw new Error('Reader service returned HTTP ' + r.status);
      return r.text();
    });
    readerCache.set(st.url, p);
    p.then(function (txt) {
      if (!live(my)) return;
      var title = (/^Title:\s*(.*)$/m.exec(txt) || [])[1] || st.title;
      var content = txt.split(/^Markdown Content:\s*$/m)[1] || txt;
      body.innerHTML = '<article class="reader rich"><h1>' + esc(title) + '</h1>' + U.mdToHTML(content) +
        '<p class="inline-note">Text version via r.jina.ai. <a href="' + esc(st.url) + '" target="_blank" rel="noopener">Original ↗</a></p></article>';
      Nav.done(S.navId, 'reader ' + st.id);
    }, function (e) {
      readerCache.delete(st.url);
      if (!live(my) || HN.isAbort(e)) return;
      Nav.log('error', 'reader ' + st.id + ': ' + e.message);
      body.innerHTML = '<div class="empty"><h2>Reader view couldn’t load this page</h2><p>' + esc(e.message) + '</p>' +
        '<p><a class="btn" href="' + esc(st.url) + '" target="_blank" rel="noopener">Open in a new tab ↗</a></p></div>';
    });
  }

  function setMode(pane, st, mode, my, remember) {
    S.mode = mode;
    if (remember) Store.setReaderSite(U.domainOf(st.url), mode === 'reader');
    pane.querySelectorAll('.seg [data-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode)); });
    if (mode === 'reader') { pane.querySelector('.pane-note').hidden = true; showReader(pane.querySelector('.pane-body'), st, my); }
    else showPage(pane, st, my);
  }

  // side = which half the keys control (desktop) and which half is shown (phone toggle).
  function setSide(side) {
    S.side = side;
    if (S.solo || !S.view) return;
    var a = S.view.querySelector('.article-pane'), c = S.view.querySelector('.comments-pane'), sp = S.view.querySelector('.split');
    if (a) a.classList.toggle('active', side === 'article');
    if (c) c.classList.toggle('active', side === 'comments');
    if (sp) sp.setAttribute('data-show', side);
    S.view.querySelectorAll('[data-side]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-side') === side)); });
  }

  // Responses are used only if this page is still the one on screen.
  function live(my) { return my === token && Nav.alive(S.navId); }

  function loadStory(id) {
    var known = Views.story(id);
    return known && known.url !== undefined ? Promise.resolve(known) : HN.getItem(id, 60000, S.signal);
  }

  var PHONE = matchMedia('(max-width: 640px)');

  /* ---------- Side by side (on a phone: a toggle between article and comments) ---------- */
  function render(id, view, back, nav) {
    var my = ++token;
    nav = nav || { id: Nav.id, signal: null };
    S = { st: null, view: view, solo: false, mode: 'page', side: 'comments', gAt: 0, navId: nav.id, signal: nav.signal };
    view.setAttribute('data-view', 'split');
    view.innerHTML = '<div class="split-toggle seg" role="group" aria-label="Show">' +
        '<button type="button" data-side="article">Article</button><button type="button" data-side="comments">Comments</button></div>' +
      '<div class="split"><section class="pane article-pane"></section><section class="pane comments-pane"></section></div>';
    var pane = view.querySelector('.article-pane'), right = view.querySelector('.comments-pane');
    setSide(PHONE.matches ? 'article' : 'comments');
    view.querySelector('.split-toggle').addEventListener('click', function (e) {
      var b = e.target.closest('[data-side]');
      if (b) setSide(b.getAttribute('data-side'));
    });
    pane.addEventListener('mousedown', function () { setSide('article'); });
    right.addEventListener('mousedown', function () { setSide('comments'); });
    Comments.render(id, null, right, { back: back, scroller: right, split: true, nav: nav });

    loadStory(id).then(function (st) {
      if (!live(my)) return;
      if (!st || !st.url) { App.go('#/item/' + id, true); return; }
      S.st = st;
      Views.markOpened(st);
      var dom = U.domainOf(st.url);
      var mode = Store.readerSite(dom) || BLOCKS.test(dom) && !/youtu/.test(dom) ? 'reader' : 'page';
      pane.innerHTML = barHTML(st, mode);
      setMode(pane, st, mode, my, false);
      pane.addEventListener('click', function (e) {
        var b = e.target.closest('[data-mode]');
        if (b) setMode(pane, st, b.getAttribute('data-mode'), my, true);
      });
    }, function (e) {
      if (live(my) && !HN.isAbort(e)) pane.innerHTML = App.errorHTML(e, 'this story');
    });
  }

  /* ---------- Reader view on its own ---------- */
  function renderReader(id, view, back, nav) {
    var my = ++token;
    nav = nav || { id: Nav.id, signal: null };
    S = { st: null, view: view, solo: true, mode: 'reader', side: 'article', gAt: 0, navId: nav.id, signal: nav.signal };
    view.setAttribute('data-view', 'read');
    view.innerHTML = '<a class="back" href="' + back.href + '">← ' + esc(back.label) + '</a><div class="reader-solo"></div>';
    var box = view.querySelector('.reader-solo');
    loadStory(id).then(function (st) {
      if (!live(my)) return;
      if (!st || !st.url) { App.go('#/item/' + id, true); return; }
      S.st = st;
      Views.markOpened(st);
      document.title = (st.title || 'Reader') + ' · The Hundred';
      box.innerHTML = '<div class="pane-bar"><span class="pane-title">' + esc(U.domainOf(st.url)) + '</span>' +
        '<a class="act" href="#/item/' + st.id + '" title="Comments (c)">Comments</a>' +
        '<a class="act" href="#/split/' + st.id + '" title="Side by side (v)">Side by side</a>' +
        '<a class="act" href="' + esc(st.url) + '" target="_blank" rel="noopener" title="Original (o)">Original ↗</a></div>' +
        '<div class="reader-body"></div>';
      showReader(box.querySelector('.reader-body'), st, my);
    }, function (e) {
      if (live(my) && !HN.isAbort(e)) box.innerHTML = App.errorHTML(e, 'this story');
    });
  }

  /* ---------- Vim-style keys for Reader view ---------- */
  function scroller() { return S.solo ? window : S.view.querySelector('.article-pane .pane-body'); }
  function viewH(sc) { return sc === window ? window.innerHeight - 110 : sc.clientHeight; }
  function move(sc, top, abs) {
    var o = { behavior: Anim.ok() ? 'smooth' : 'auto' };
    if (abs) { o.top = top; sc.scrollTo(o); } else { o.top = top; sc.scrollBy(o); }
  }

  var SCROLL_KEYS = { j: 1, k: 1, d: 1, u: 1, ' ': 1, g: 1, G: 1 };

  // Returns true if the key belongs to the reader (so nothing else acts on it).
  function key(e) {
    var k = e.key, st = S.st;
    if (!st) return SCROLL_KEYS[k] || k === 'c' || k === 'o';
    if (k === 'o') { window.open(st.url, '_blank', 'noopener'); return true; }
    if (k === 'c') {
      if (S.solo) App.go('#/item/' + st.id);
      else { setSide('comments'); var c = S.view.querySelector('.comments-pane'); if (c) Anim.replay(c, 'pane-pulse'); }
      return true;
    }
    if (!SCROLL_KEYS[k]) return false;
    if (S.mode !== 'reader') { App.toast('Scrolling keys work in Reader view'); return true; }
    var sc = scroller();
    if (!sc) return true;
    var h = viewH(sc);
    if (k === 'j') move(sc, 80);
    else if (k === 'k') move(sc, -80);
    else if (k === 'd') move(sc, h / 2);
    else if (k === 'u') move(sc, -h / 2);
    else if (k === ' ') move(sc, (e.shiftKey ? -1 : 1) * h * 0.9);
    else if (k === 'G') move(sc, sc === window ? document.documentElement.scrollHeight : sc.scrollHeight, true);
    else if (k === 'g') {
      if (Date.now() - S.gAt < 500) { move(sc, 0, true); S.gAt = 0; }
      else S.gAt = Date.now();
    }
    return true;
  }

  g.Split = {
    render: render, reader: renderReader, key: key,
    leave: function () { token++; S.view = null; },
    side: function () { return S.solo ? 'article' : S.side; },
    toggleSide: function () { setSide(S.side === 'article' ? 'comments' : 'article'); },
    story: function () { return S.st; }
  };
})(window);
