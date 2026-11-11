/* ==== VIEW: profile ==== username, karma, account age, about, recent submissions. */
(function (g) {
  'use strict';

  var esc = U.esc;
  var token = 0;

  function ageText(created) {
    if (!created) return '';
    var days = Math.floor((Date.now() / 1000 - created) / 86400);
    var span = days >= 365 ? U.plural(Math.floor(days / 365), 'year')
      : days >= 30 ? U.plural(Math.floor(days / 30), 'month') : U.plural(Math.max(days, 0), 'day');
    var when = new Date(created * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    return span + ' (joined ' + when + ')';
  }

  function pageHTML(name, data, back) {
    var u = data.user;
    var head = '<a class="back" href="' + back.href + '">← ' + esc(back.label) + '</a>';
    if (!u) {
      return head + '<div class="empty"><h2>No user called “' + esc(name) + '”</h2>' +
        '<p>The account may not exist, or the name is misspelled.</p></div>';
    }
    var stories = data.stories;
    var list;
    if (stories == null) list = '<div class="inline-note">Loading submissions…</div>';
    else if (!stories.length) list = '<div class="inline-note">No story submissions found.</div>';
    else list = '<ol class="list">' + stories.map(function (st, i) { return Views.rowHTML(st, i); }).join('') + '</ol>';

    return head +
      '<header class="item-head profile-head">' +
        '<h1 class="item-title">' + esc(u.id) + '</h1>' +
        '<dl class="profile-stats">' +
          '<div><dt>Karma</dt><dd>' + (u.karma || 0).toLocaleString() + '</dd></div>' +
          '<div><dt>Account age</dt><dd>' + esc(ageText(u.created)) + '</dd></div>' +
        '</dl>' +
        (u.about ? '<div class="item-text rich">' + U.richHTML(u.about) + '</div>' : '') +
        '<div class="meta"><a href="https://news.ycombinator.com/user?id=' + encodeURIComponent(u.id) +
          '" target="_blank" rel="noopener">view on HN ↗</a></div>' +
      '</header>' +
      '<div class="comments-head">Recent submissions</div>' + list;
  }

  function skeleton(back) {
    return '<a class="back" href="' + back.href + '">← ' + esc(back.label) + '</a>' +
      '<header class="item-head"><div class="skel t" style="width:30%;height:24px"></div><div class="skel s"></div></header>';
  }

  /* Recent stories via Algolia; fallback: the official "submitted" ids. */
  function loadStories(u, nav) {
    return HN.userStories(u.id, nav.signal).catch(function (e) {
      if (HN.isAbort(e)) throw e;
      var ids = (u.submitted || []).slice(0, 60);
      return U.pool(ids, 24, function (id) {
        if (!Nav.alive(nav.id)) return null;
        return HN.getItem(id, 600000, nav.signal).catch(function () { return null; });
      }).then(function (items) {
          return items.filter(function (it) {
            return it && !it.__error && !HN.isGone(it) && (it.type === 'story' || it.type === 'poll');
          }).slice(0, 30);
        });
    });
  }

  // A response is used only if this profile is still the page on screen.
  var navId = 0;
  function live(my) { return my === token && Nav.alive(navId); }

  function render(name, view, back, nav) {
    var my = ++token;
    nav = nav || { id: Nav.id, signal: null };
    navId = nav.id;
    var data = null;
    function paint() { if (live(my) && data) view.innerHTML = pageHTML(name, data, back); }

    view.innerHTML = skeleton(back);
    window.scrollTo(0, 0);
    document.title = name + ' · The Hundred';

    var gotFresh = false, done = false, busyOn = false;
    function setBusy(on) { if (on !== busyOn) { busyOn = on; App.busy(on ? 1 : -1); } }

    // Cached profile paints instantly; "updating…" shows until the refresh lands.
    Store.db.get('users', name).then(function (c) {
      if (c && c.user && !gotFresh && live(my)) { data = c; paint(); if (!done) setBusy(true); }
    });

    HN.getUser(name, nav.signal).then(function (u) {
      gotFresh = true;
      if (!live(my)) return;
      var prevStories = data && data.user ? data.stories : null;
      data = { user: u, stories: prevStories };
      paint();
      Nav.done(nav.id, 'profile ' + name);
      if (!u) return;
      return loadStories(u, nav).then(function (stories) {
        Store.db.put('users', name, { user: u, stories: stories });   // keep it even if you've left
        if (!live(my)) return;
        data = { user: u, stories: stories };
        paint();
      });
    }).catch(function (err) {
      if (!live(my) || HN.isAbort(err)) return;
      Nav.log('error', 'profile ' + name + ': ' + err.message);
      if (!data) {
        view.innerHTML = '<a class="back" href="' + back.href + '">← ' + esc(back.label) + '</a>' + App.errorHTML(err, 'this profile');
      }
    }).then(function () { done = true; setBusy(false); });
  }

  g.User = { render: render };
})(window);
