/* ==== STATE: story lists ====
   Official API gives the exact ranking; Algolia narrows ~500 ids to the few near 100+ comments
   in a handful of requests; the official API confirms live counts. Background checks re-fetch
   only stories that changed (HN's "updates" feed or a higher Algolia count). */
(function (g) {
  'use strict';

  var MIN = 100, CANDIDATE_MIN = 90, CONCURRENCY = 48;
  var NEW_MARK_MS = 20 * 60000, REFRESH_MIN = 3 * 60000, REFRESH_MAX = 5 * 60000;
  var SOURCES = ['top', 'best', 'new', 'ask', 'show', 'jobs'];

  var state = {};
  SOURCES.forEach(function (k) {
    state[k] = { stories: [], status: 'idle', error: null, refreshError: null, scanned: 0, total: 0, listSize: 0,
      failed: 0, phase: '', via: '', loadedAt: 0, snapshotAt: 0, painted: false, baseline: null,
      newAt: new Map(), promise: null, busy: false };
  });

  var listeners = [], queued = false, nextCheckAt = 0, timer = null;
  function emit() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; listeners.forEach(function (fn) { fn(); }); });
  }

  function qualifies(tab, it) {
    if (HN.isGone(it)) return false;
    if (tab === 'jobs') return true;                               // no comment rule on Jobs
    return (it.type === 'story' || it.type === 'poll') && (it.descendants || 0) >= MIN;
  }

  function setBusy(s, on) { if (s.busy !== on) { s.busy = on; App.busy(on ? 1 : -1); } }

  function withRank(rank, it) { return Object.assign({ hnRank: rank.get(it.id) + 1 }, it); }

  /* Every id through the official API: Jobs, and the fallback when Algolia is down. */
  function scanOfficial(tab, ids, fresh, paint) {
    var s = state[tab], rank = new Map(ids.map(function (id, i) { return [id, i]; }));
    var results = new Array(ids.length), last = 0;
    s.phase = 'scan'; s.via = 'official'; s.total = ids.length; s.scanned = 0;
    function collect() {
      return results.filter(function (it) { return it && !it.__error && qualifies(tab, it); }).map(function (it) { return withRank(rank, it); });
    }
    return U.pool(ids, CONCURRENCY, function (id, i) {
      return HN.getItem(id, fresh ? 0 : 90000).then(function (it) { results[i] = it; }, function (e) {
        s.failed++; results[i] = { __error: e };
      }).then(function () {
        s.scanned++;
        if (paint && !s.snapshotAt && Date.now() - last > 120) { last = Date.now(); paint(collect()); }
        emit();
      });
    }).then(function () {
      if (ids.length && s.failed === ids.length) throw new Error('Every story request failed.');
      return collect();
    });
  }

  function scanAlgolia(tab, ids, fresh, paint) {
    var s = state[tab], rank = new Map(ids.map(function (id, i) { return [id, i]; }));
    s.phase = 'algolia'; s.via = 'algolia';
    return Promise.all([HN.storiesByIds(ids, CANDIDATE_MIN), fresh ? HN.changedIds() : null]).then(function (r) {
      var res = r[0], changed = r[1];
      if (paint) paint(Array.from(res.hits.values()).filter(function (x) { return x.descendants >= MIN && rank.has(x.id); })
        .map(function (x) { return withRank(rank, x); }).sort(function (a, b) { return a.hnRank - b.hnRank; }));

      var cand = Array.from(new Set(Array.from(res.hits.keys()).concat(res.failedIds)))
        .filter(function (id) { return rank.has(id); }).sort(function (a, b) { return rank.get(a) - rank.get(b); });

      // Which candidates need a live re-check? On first load: anything not cached recently.
      // On background checks: only changed stories, or ones whose Algolia count moved past our copy.
      function stale(id) {
        var age = HN.itemAge(id), have = HN.peekItem(id), alg = res.hits.get(id);
        if (!have) return true;
        if (!fresh) return age > 90000;
        if (changed && changed.has(id)) return true;
        if (alg && alg.descendants > (have.descendants || 0)) return true;
        return age > 15 * 60000;
      }
      s.phase = 'verify'; s.total = cand.length; s.scanned = 0;
      return U.pool(cand, CONCURRENCY, function (id) {
        var need = stale(id);
        return HN.getItem(id, need ? 0 : Infinity).catch(function (e) { s.failed++; return { __error: e }; })
          .then(function (it) { s.scanned++; emit(); return it; });
      }).then(function (results) {
        var out = [];
        cand.forEach(function (id, i) {
          var off = results[i], alg = res.hits.get(id);
          if (off && !off.__error) { if (qualifies(tab, off)) out.push(withRank(rank, off)); }
          else if (alg && alg.descendants >= MIN) out.push(withRank(rank, alg));
        });
        return out;
      });
    });
  }

  function scan(tab, fresh) {
    var s = state[tab];
    if (s.promise) return s.promise;
    var background = s.loadedAt > 0;
    s.status = background ? 'refreshing' : 'loading';
    s.scanned = s.total = s.failed = 0; s.refreshError = null; s.phase = 'list';
    if (background || s.stories.length) setBusy(s, true);
    emit();
    var paint = background ? null : function (stories) { s.stories = stories; s.painted = true; s.snapshotAt = 0; emit(); };

    s.promise = HN.getList(tab).then(function (ids) {
      s.listSize = ids.length;
      if (tab === 'jobs') return scanOfficial(tab, ids, fresh, paint);
      return scanAlgolia(tab, ids, fresh, paint).catch(function () { s.failed = 0; return scanOfficial(tab, ids, fresh, paint); });
    }).then(function (stories) { finish(tab, stories); }, function (err) {
      if (s.stories.length) { s.refreshError = err; s.status = s.loadedAt ? 'ready' : 'stale'; }
      else { s.status = 'error'; s.error = err; }
    }).then(function () { s.promise = null; setBusy(s, false); emit(); });
    return s.promise;
  }

  function finish(tab, stories) {
    var s = state[tab], now = Date.now(), ids = new Set(stories.map(function (x) { return x.id; }));
    if (s.baseline) ids.forEach(function (id) { if (!s.baseline.has(id)) s.newAt.set(id, now); });
    s.baseline = ids;
    s.newAt.forEach(function (t, id) { if (now - t > NEW_MARK_MS || !ids.has(id)) s.newAt.delete(id); });
    s.stories = stories; s.status = 'ready'; s.error = null; s.snapshotAt = 0; s.loadedAt = now;
    Store.db.put('lists', tab, { t: now, s: stories.map(function (x) {
      return { id: x.id, hnRank: x.hnRank, type: x.type, title: x.title, url: x.url, score: x.score, by: x.by, time: x.time, descendants: x.descendants };
    }) });
  }

  function isNew(tab, id) {
    var t = state[tab] && state[tab].newAt.get(id);
    return !!t && Date.now() - t < NEW_MARK_MS;
  }

  function loadSnapshot(tab) {
    var s = state[tab];
    if (s.loadedAt || s.stories.length) return;
    Store.db.get('lists', tab).then(function (o) {
      if (!o || !Array.isArray(o.s) || Date.now() - o.t > 864e5 || s.loadedAt || s.painted || s.stories.length) return;
      s.stories = o.s; s.snapshotAt = o.t;
      if (s.status === 'error') s.status = 'stale';
      if (s.promise) setBusy(s, true);
      emit();
    });
  }

  /* ---------- Background checks every 3–5 minutes ---------- */
  function scheduleNext() {
    clearTimeout(timer);
    var delay = REFRESH_MIN + Math.random() * (REFRESH_MAX - REFRESH_MIN);
    nextCheckAt = Date.now() + delay;
    timer = setTimeout(function () { refreshAll(App.currentSource()); }, delay);
  }

  function refreshAll(first) {
    var order = first && state[first] ? [first] : [];
    ['top', 'best'].concat(SOURCES).forEach(function (k) { if (order.indexOf(k) < 0 && state[k].loadedAt) order.push(k); });
    var chain = Promise.resolve();
    order.forEach(function (k) { chain = chain.then(function () { return scan(k, true); }); });
    if (Store.saved().length) chain = chain.then(refreshSaved);
    scheduleNext();
    return chain;
  }

  /* Load a source tab (saved copy first), then warm Top and Best. For You needs Top/Best/Ask/Show. */
  function ensure(tab) {
    var tabs = tab === 'foryou' ? ['top', 'best', 'ask', 'show'] : state[tab] ? [tab] : [];
    var first = Promise.all(tabs.map(function (t) {
      loadSnapshot(t);
      return state[t].loadedAt ? null : scan(t, false);
    }));
    first.then(function () {
      ['top', 'best'].forEach(function (k) { if (!state[k].loadedAt && !state[k].promise) { loadSnapshot(k); scan(k, false); } });
    });
    if (!timer) scheduleNext();
  }

  /* ---------- Saved: refresh counts in one request ---------- */
  var savedAt = 0;
  function refreshSaved() {
    var ids = Store.saved().map(function (s) { return s.id; });
    if (!ids.length) return Promise.resolve();
    savedAt = Date.now();
    return HN.storiesByIds(ids, 0).then(function (r) { Store.updateSaved(r.hits); emit(); }, function () {});
  }

  /* ---------- For You: 100+ stories from Top/Best/Ask/Show, ranked by this browser's model ---------- */
  function forYou() {
    var seen = new Set(), pool = [];
    ['top', 'best', 'ask', 'show'].forEach(function (k) {
      state[k].stories.forEach(function (st) { if (!seen.has(st.id)) { seen.add(st.id); pool.push(st); } });
    });
    return pool.map(function (st) {
      var m = Store.interest(st), topics = Store.topicMatches(st);
      var score = m.s + topics.length * 2 +
        Math.log10(1 + (st.descendants || 0)) * 0.3 + Math.log10(1 + (st.score || 0)) * 0.2 +
        (Store.isRead(st.id) ? -1.5 : 0) - Math.min(3, (Date.now() / 1000 - st.time) / 86400) * 0.3;
      return Object.assign({}, st, { _score: score, _why: topics.concat(m.why).slice(0, 2) });
    }).sort(function (a, b) { return b._score - a._score; });
  }

  function anyLoading(tabs) { return tabs.some(function (t) { return state[t].status === 'loading'; }); }

  g.Lists = {
    MIN: MIN, SOURCES: SOURCES, state: state, ensure: ensure, scan: scan, refreshAll: refreshAll,
    refreshSaved: function () { return Date.now() - savedAt > 60000 ? refreshSaved() : Promise.resolve(); },
    isNew: isNew, forYou: forYou, anyLoading: anyLoading,
    onChange: function (fn) { listeners.push(fn); }, emit: emit,
    nextCheckAt: function () { return nextCheckAt; }
  };
})(window);
