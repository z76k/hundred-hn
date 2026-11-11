/* ==== STORE: everything kept in the browser ====
   Small, synchronous data (settings, read/seen marks, saved, topics, For You model) lives in
   localStorage; large data (lists, threads, profiles) lives in IndexedDB. */
(function (g) {
  'use strict';

  /* ---------- localStorage JSON with in-memory copies and batched writes ---------- */
  var mem = {}, dirty = {}, timer = null;
  function load(key, def) {
    if (!(key in mem)) {
      try { mem[key] = JSON.parse(localStorage.getItem('hundred.' + key)) || def; } catch (e) { mem[key] = def; }
    }
    return mem[key];
  }
  function save(key) {
    dirty[key] = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 250);
  }
  function flush() {
    Object.keys(dirty).forEach(function (k) {
      try { localStorage.setItem('hundred.' + k, JSON.stringify(mem[k])); } catch (e) {}
    });
    dirty = {};
  }
  addEventListener('pagehide', flush);

  var listeners = [];
  function changed(what) { listeners.forEach(function (fn) { fn(what); }); }

  /* ---------- Settings ---------- */
  var DEFAULTS = { theme: 'auto', md: true, order: 'top', autoOpen: true, debug: false };
  function pref(k) { var p = load('prefs', {}); return k in p ? p[k] : DEFAULTS[k]; }
  function setPref(k, v) { load('prefs', {})[k] = v; save('prefs'); changed('prefs'); }
  // Migrate the earlier separate keys once.
  try {
    var oldTheme = localStorage.getItem('hundred.theme'), oldMd = localStorage.getItem('hundred.markdown');
    if (oldTheme && !/^\{/.test(oldTheme)) { load('prefs', {}).theme = oldTheme; localStorage.removeItem('hundred.theme'); save('prefs'); }
    if (oldMd) { load('prefs', {}).md = oldMd !== 'off'; localStorage.removeItem('hundred.markdown'); save('prefs'); }
  } catch (e) {}

  /* ---------- Read marks + new-comment tracking (one record per story) ----------
     { m: highest comment id seen (null if only the article was opened), n: comment count, t: time } */
  var SEEN_DAYS = 30;
  function seenAll() { return load('seen', {}); }
  function seen(id) { return seenAll()[id] || null; }
  function markSeen(id, m, n) {
    var all = seenAll(), cur = all[id] || {};
    all[id] = { m: Math.max(cur.m || 0, m || 0) || null, n: Math.max(cur.n || 0, n || 0), t: Date.now() };
    save('seen');
    changed('seen');
  }
  function newCount(st) {
    var s = seen(st.id);
    return s ? Math.max(0, (st.descendants || 0) - (s.n || 0)) : 0;
  }
  (function prune() {
    var all = seenAll(), cut = Date.now() - SEEN_DAYS * 864e5, n = 0;
    Object.keys(all).forEach(function (k) { if (all[k].t < cut) { delete all[k]; n++; } });
    if (n) save('seen');
  })();

  /* ---------- Saved stories ---------- */
  function compact(st) {
    return { id: st.id, type: st.type, title: st.title, url: st.url, by: st.by, time: st.time,
      score: st.score, descendants: st.descendants };
  }
  function savedList() { return load('saved', []); }
  function isSaved(id) { return savedList().some(function (s) { return s.id === id; }); }
  function toggleSave(st) {
    var list = savedList(), i = list.findIndex(function (s) { return s.id === st.id; });
    if (i >= 0) list.splice(i, 1);
    else list.unshift(Object.assign(compact(st), { savedAt: Date.now() }));
    save('saved');
    learn(st, i >= 0 ? -2 : 3);
    changed('saved');
    return i < 0;
  }
  function updateSaved(fresh) {   // fresh: Map id -> story with new counts
    savedList().forEach(function (s) {
      var f = fresh.get(s.id);
      if (f) { s.score = f.score; s.descendants = f.descendants; s.title = f.title || s.title; }
    });
    save('saved');
  }

  /* ---------- Followed topics ---------- */
  var topicRes = null;
  function topics() { return load('topics', []); }
  function setTopics(list) {
    mem.topics = list.map(function (t) { return t.trim(); }).filter(Boolean)
      .filter(function (t, i, a) { return a.findIndex(function (x) { return x.toLowerCase() === t.toLowerCase(); }) === i; });
    topicRes = null;
    save('topics');
    changed('topics');
  }
  function topicMatches(st) {
    if (!topicRes) topicRes = topics().map(function (t) {
      var e = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { t: t, re: new RegExp('(^|[^\\w])' + e + '(?![\\w])', 'i') };
    });
    var hay = (st.title || '') + ' ' + U.domainOf(st.url);
    return topicRes.filter(function (x) { return x.re.test(hay); }).map(function (x) { return x.t; });
  }

  /* ---------- For You: a tiny weighted-feature model, learned only from this browser ---------- */
  var STOP = new Set(('the and for with from that this your you our are was were how why what when who into about ' +
    'over than then them they its it\'s not but can will just new now use using via vs show ask tell hn launch ' +
    'yc pdf video one two all more most out has have had get got make made does did don\'t').split(' '));
  var MAX_FEATURES = 600;

  function features(st) {
    var f = [], title = (st.title || '').toLowerCase();
    var d = U.domainOf(st.url);
    if (d) f.push('d:' + d);
    if (/^show hn/.test(title)) f.push('k:Show HN');
    if (/^ask hn/.test(title)) f.push('k:Ask HN');
    (title.replace(/^(show|ask|tell|launch) hn:?/, '').match(/[a-z0-9][a-z0-9+#.-]{1,}/g) || []).forEach(function (w) {
      w = w.replace(/[.-]+$/, '');
      if (w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)) f.push('w:' + w);
    });
    return Array.from(new Set(f));
  }

  function model() { return load('model', { w: {}, t: Date.now() }); }

  function learn(st, amount) {
    if (!st || !amount) return;
    var m = model(), now = Date.now(), days = (now - m.t) / 864e5;
    if (days > 0.25) {   // old interests fade ~3% a day
      var k = Math.pow(0.97, days);
      Object.keys(m.w).forEach(function (f) { m.w[f] *= k; if (Math.abs(m.w[f]) < 0.01) delete m.w[f]; });
      m.t = now;
    }
    var fs = features(st);
    if (!fs.length) return;
    var per = amount / Math.sqrt(fs.length);
    fs.forEach(function (f) { m.w[f] = (m.w[f] || 0) + per; });
    var keys = Object.keys(m.w);
    if (keys.length > MAX_FEATURES) {
      keys.sort(function (a, b) { return Math.abs(m.w[b]) - Math.abs(m.w[a]); })
        .slice(MAX_FEATURES).forEach(function (f) { delete m.w[f]; });
    }
    save('model');
  }

  function interest(st) {
    var w = model().w, s = 0, best = [];
    features(st).forEach(function (f) {
      var v = w[f] || 0;
      s += v;
      if (v > 0.05) best.push([v, f.slice(2)]);
    });
    best.sort(function (a, b) { return b[0] - a[0]; });
    return { s: s, why: best.slice(0, 2).map(function (x) { return x[1]; }) };
  }
  function modelSize() { return Object.keys(model().w).length; }
  function resetModel() { mem.model = { w: {}, t: Date.now() }; save('model'); changed('model'); }

  /* ---------- Side-by-side: sites where reader view was chosen ---------- */
  function readerSite(domain) { return load('readerSites', []).indexOf(domain) >= 0; }
  function setReaderSite(domain, on) {
    var l = load('readerSites', []), i = l.indexOf(domain);
    if (on && i < 0) l.push(domain);
    if (!on && i >= 0) l.splice(i, 1);
    save('readerSites');
  }

  /* ---------- IndexedDB (resolves null/false on any failure) ---------- */
  var dbp = null;
  function open() {
    if (!dbp) dbp = new Promise(function (res) {
      try {
        var r = indexedDB.open('hundred', 1);
        r.onupgradeneeded = function () {
          ['lists', 'threads', 'users'].forEach(function (n) {
            if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n);
          });
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = r.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return open().then(function (d) {
      if (!d) return null;
      return new Promise(function (res) {
        try {
          var t = d.transaction(store, mode), q = fn(t.objectStore(store));
          t.oncomplete = function () { res(q && 'result' in q ? q.result : true); };
          t.onerror = t.onabort = function () { res(null); };
        } catch (e) { res(null); }
      });
    });
  }
  var db = {
    get: function (s, k) { return tx(s, 'readonly', function (o) { return o.get(String(k)); }).then(function (v) { return v || null; }); },
    put: function (s, k, v) { return tx(s, 'readwrite', function (o) { o.put(v, String(k)); }); },
    del: function (s, k) { return tx(s, 'readwrite', function (o) { o.delete(String(k)); }); }
  };

  g.Store = {
    pref: pref, setPref: setPref,
    seen: seen, markSeen: markSeen, isRead: function (id) { return !!seen(id); }, newCount: newCount,
    saved: savedList, isSaved: isSaved, toggleSave: toggleSave, updateSaved: updateSaved,
    topics: topics, setTopics: setTopics, topicMatches: topicMatches,
    learn: learn, interest: interest, modelSize: modelSize, resetModel: resetModel,
    readerSite: readerSite, setReaderSite: setReaderSite,
    db: db, on: function (fn) { listeners.push(fn); }
  };
})(window);
