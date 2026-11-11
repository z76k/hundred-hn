/* ==== DATA / API ====
   Official HN API (exact rankings, live counts, users, "what changed" feed) and Algolia
   (stories-by-id in bulk, whole comment trees in one request, search). In-memory caches
   sit in front of both; threads also persist to IndexedDB. */
(function (g) {
  'use strict';

  var FB = 'https://hacker-news.firebaseio.com/v0/';
  var ALG = 'https://hn.algolia.com/api/v1/';

  /* ---------- Navigation IDs, cancellation, debug log ----------
     Every page visit gets an id and an AbortController. Starting a new visit aborts the
     previous one; pages check Nav.alive(id) before drawing anything that arrives late. */
  var LOG_KEY = 'hundred.navlog';
  var Nav = { id: 0, ctl: null, hash: '' };
  Nav.start = function (hash) {
    if (Nav.ctl) { Nav.ctl.abort(); Nav.log('cancel', '#' + Nav.id + ' ' + Nav.hash); }
    Nav.ctl = new AbortController();
    Nav.id++;
    Nav.hash = hash;
    Nav.log('start', '#' + Nav.id + ' ' + hash);
    return { id: Nav.id, signal: Nav.ctl.signal };
  };
  Nav.alive = function (id) { return id === Nav.id; };
  Nav.done = function (id, what) { if (id === Nav.id) Nav.log('finish', '#' + id + ' ' + (what || Nav.hash)); };
  Nav.log = function (type, detail) {
    if (!Store.pref('debug')) return;
    var list = Nav.entries();
    var d = new Date();
    list.push(d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0') + '  ' +
      (type + '      ').slice(0, 7) + ' ' + String(detail || '').slice(0, 160));
    try { localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-20))); } catch (e) {}
  };
  Nav.entries = function () { try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch (e) { return []; } };
  Nav.clear = function () { try { localStorage.removeItem(LOG_KEY); } catch (e) {} };
  function isAbort(e) { return e && e.name === 'AbortError'; }
  function abortError() { var e = new Error('Cancelled'); e.name = 'AbortError'; return e; }

  // Reject as soon as `signal` aborts, without cancelling the underlying work.
  function untilAbort(p, signal) {
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise(function (res, rej) {
      function on() { rej(abortError()); }
      signal.addEventListener('abort', on, { once: true });
      p.then(function (v) { signal.removeEventListener('abort', on); res(v); },
        function (e) { signal.removeEventListener('abort', on); rej(e); });
    });
  }

  /* De-duplicated request shared by several callers. The network request is aborted only when
     every page that asked for it has left; callers without a signal (prefetch, background
     refresh) keep it alive so the result still lands in the cache. */
  function shared(map, key, start, signal) {
    var e = map.get(key);
    if (!e) {
      e = { ctl: new AbortController(), users: 0, keep: false };
      e.p = start(e.ctl.signal).finally(function () { if (map.get(key) === e) map.delete(key); });
      e.p.catch(function () {});
      map.set(key, e);
    }
    if (!signal) { e.keep = true; return e.p; }
    if (signal.aborted) return Promise.reject(abortError());
    e.users++;
    signal.addEventListener('abort', function () {
      e.users--;
      if (e.users <= 0 && !e.keep) { e.ctl.abort(); if (map.get(key) === e) map.delete(key); }
    }, { once: true });
    return untilAbort(e.p, signal);
  }

  function getJSON(url, ms, signal) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 12000);
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
    }
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).hostname);
      return r.json();
    }).catch(function (e) {
      if (signal && signal.aborted) throw abortError();
      throw e;
    }).finally(function () { clearTimeout(timer); });
  }

  /* ---------- Official API ---------- */
  var items = new Map();     // id -> { v, t }
  var inflight = new Map();

  function fb(path, signal) {
    return shared(inflight, path, function (sig) {
      return getJSON(FB + path, 12000, sig).catch(function (e) {        // one retry
        if (isAbort(e)) throw e;
        return U.timeout(400).then(function () { return getJSON(FB + path, 12000, sig); });
      });
    }, signal);
  }

  function getItem(id, maxAgeMs, signal) {
    var c = items.get(id);
    if (c && Date.now() - c.t < (maxAgeMs == null ? 60000 : maxAgeMs)) return Promise.resolve(c.v);
    return fb('item/' + id + '.json', signal).then(function (v) { items.set(id, { v: v, t: Date.now() }); return v; });
  }

  var LIST = { top: 'topstories', best: 'beststories', new: 'newstories', ask: 'askstories', show: 'showstories', jobs: 'jobstories' };
  function getList(tab) {
    return fb(LIST[tab] + '.json').then(function (ids) {
      return Array.isArray(ids) ? ids.filter(function (x) { return typeof x === 'number'; }) : [];
    });
  }

  // Ids changed in the last few minutes; lets background checks skip unchanged stories.
  var updates = { t: 0, ids: new Set() };
  function changedIds() {
    if (Date.now() - updates.t < 60000) return Promise.resolve(updates.ids);
    return fb('updates.json').then(function (u) {
      updates = { t: Date.now(), ids: new Set((u && u.items) || []) };
      return updates.ids;
    }, function () { return null; });
  }

  function isGone(it) { return !it || it.deleted || it.dead; }

  /* ---------- Algolia ---------- */
  function fromHit(h) {
    var tags = h._tags || [];
    return {
      id: Number(h.objectID), type: tags.indexOf('poll') >= 0 ? 'poll' : tags.indexOf('comment') >= 0 ? 'comment' : 'story',
      title: h.title, url: h.url || undefined, by: h.author, score: h.points, time: h.created_at_i,
      descendants: h.num_comments || 0, text: h.comment_text || h.story_text || '',
      storyId: h.story_id, storyTitle: h.story_title
    };
  }

  /* Many story ids at once (200 per request), keeping those with >= minComments.
     Failed chunks are reported in failedIds rather than thrown. */
  function storiesByIds(ids, minComments) {
    var chunks = [], hits = new Map(), failedIds = [];
    for (var i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
    return Promise.all(chunks.map(function (chunk) {
      var q = 'search?tags=' + encodeURIComponent('(story,poll),(' + chunk.map(function (id) { return 'story_' + id; }).join(',') + ')') +
        '&numericFilters=' + encodeURIComponent('num_comments>=' + minComments) + '&hitsPerPage=' + chunk.length +
        '&attributesToRetrieve=' + encodeURIComponent('title,url,author,points,num_comments,created_at_i,_tags') + '&attributesToHighlight=';
      return getJSON(ALG + q, 15000).then(function (res) {
        (res.hits || []).forEach(function (h) { var s = fromHit(h); if (s.id) hits.set(s.id, s); });
      }, function () { failedIds.push.apply(failedIds, chunk); });
    })).then(function () {
      if (chunks.length && failedIds.length === ids.length) throw new Error('Algolia unavailable');
      return { hits: hits, failedIds: failedIds };
    });
  }

  /* Search. o: { q, type: all|story|ask|show|comment, sort: relevance|popular|date,
     since (unix s), points, comments, page } */
  var searchCache = new Map();
  function search(o, signal) {
    var tags = { all: '(story,comment,poll)', story: '(story,poll)', ask: 'ask_hn', show: 'show_hn', comment: 'comment' }[o.type] || 'story';
    var nf = [];
    if (o.since) nf.push('created_at_i>' + o.since);
    if (o.type !== 'comment') {
      if (o.points) nf.push('points>=' + o.points);
      if (o.comments) nf.push('num_comments>=' + o.comments);
    }
    var path = (o.sort === 'date' ? 'search_by_date' : 'search') + '?query=' + encodeURIComponent(o.q || '') +
      '&tags=' + encodeURIComponent(tags) + (nf.length ? '&numericFilters=' + encodeURIComponent(nf.join(',')) : '') +
      '&hitsPerPage=40&page=' + (o.page || 0) + '&attributesToHighlight=';
    if (searchCache.has(path)) return Promise.resolve(searchCache.get(path));
    return getJSON(ALG + path, 15000, signal).then(function (res) {
      var out = { hits: (res.hits || []).map(fromHit), total: res.nbHits || 0, pages: res.nbPages || 0, page: res.page || 0 };
      if (o.sort === 'popular') out.hits.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      searchCache.set(path, out);
      if (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value);
      return out;
    });
  }

  function userStories(name, signal) {
    return getJSON(ALG + 'search_by_date?tags=' + encodeURIComponent('(story,poll),author_' + name) +
      '&hitsPerPage=30&attributesToHighlight=', 15000, signal).then(function (res) { return (res.hits || []).map(fromHit); });
  }

  /* ---------- Thread trees: one Algolia request per story, cached ---------- */
  var trees = new Map(), treeFlight = new Map(), storyOfComment = new Map();
  var KEEP = 40, INDEX = 'hundred.threadIndex';

  function norm(n, storyId) {
    var kids = (n.children || []).map(function (c) { return norm(c, storyId); });
    return {
      id: n.id, type: n.type, by: n.author || null, time: n.created_at_i, text: n.text || '',
      title: n.title, url: n.url || undefined, score: n.points, storyId: n.story_id || storyId,
      parentId: n.parent_id, deleted: n.type === 'comment' && !n.author && !n.text, children: kids
    };
  }

  function index(node, sid) {
    node.children.forEach(function (c) { storyOfComment.set(c.id, sid); index(c, sid); });
  }

  function remember(id, entry) {
    trees.set(id, entry);
    var n = entry.node;
    if (n.type !== 'comment') index(n, n.id);
    else if (n.storyId) { storyOfComment.set(n.id, n.storyId); index(n, n.storyId); }
  }

  function persist(id, entry) {
    if (entry.node.type === 'comment') return;
    Store.db.put('threads', id, entry);
    var idx = {};
    try { idx = JSON.parse(localStorage.getItem(INDEX) || '{}'); } catch (e) {}
    idx[id] = entry.t;
    Object.keys(idx).sort(function (a, b) { return idx[b] - idx[a]; }).slice(KEEP).forEach(function (k) {
      delete idx[k]; Store.db.del('threads', k);
    });
    try { localStorage.setItem(INDEX, JSON.stringify(idx)); } catch (e) {}
  }

  // signal: the asking page's cancel signal. Leaving that page aborts the download unless
  // something else (prefetch) also wants it; if it already arrived, it stays cached.
  function fetchTree(id, signal) {
    return shared(treeFlight, id, function (sig) {
      return getJSON(ALG + 'items/' + id, 20000, sig).then(function (raw) {
        if (!raw || raw.id == null) throw new Error('Algolia returned no item');
        var entry = { t: Date.now(), node: norm(raw, raw.story_id) };
        remember(id, entry);
        persist(id, entry);
        return entry.node;
      });
    }, signal);
  }

  function cachedTree(id) {
    if (trees.has(id)) return Promise.resolve(trees.get(id));
    return Store.db.get('threads', id).then(function (e) {
      if (e && e.node && !trees.has(id)) remember(id, e);
      return trees.get(id) || null;
    });
  }

  var prefetching = 0;
  function prefetch(id) {
    var m = trees.get(id);
    if ((m && Date.now() - m.t < 120000) || treeFlight.has(id) || prefetching >= 3) return;
    prefetching++;
    fetchTree(id).catch(function () {}).then(function () { prefetching--; });
  }

  g.Nav = Nav;
  g.HN = {
    getItem: getItem, peekItem: function (id) { var c = items.get(id); return c ? c.v : undefined; },
    itemAge: function (id) { var c = items.get(id); return c ? Date.now() - c.t : Infinity; },
    getList: getList, changedIds: changedIds, isGone: isGone, isAbort: isAbort,
    getUser: function (name, signal) { return fb('user/' + encodeURIComponent(name) + '.json', signal); },
    storiesByIds: storiesByIds, search: search, userStories: userStories
  };
  g.Thread = {
    fetch: fetchTree, peek: function (id) { return trees.get(id) || null; }, cached: cachedTree, prefetch: prefetch,
    storyOf: function (id) { return storyOfComment.get(id) || null; }
  };
})(window);
