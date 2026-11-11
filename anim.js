/* ==== ANIMATIONS ====
   Short (150–300 ms), transform/opacity/height only, and fully off when the system asks
   for reduced motion. CSS handles the rest (see styles.css "Motion"). */
(function (g) {
  'use strict';
  var reduce = matchMedia('(prefers-reduced-motion: reduce)');
  function ok() { return !reduce.matches; }
  var EASE = 'cubic-bezier(.2,.7,.2,1)';

  function stop(el) { if (el._anim) { el._anim.onfinish = null; el._anim.cancel(); el._anim = null; } el.style.overflow = ''; }

  // Height-animate a block open. Very tall blocks only fade, to keep long threads smooth.
  function expand(el) {
    stop(el);
    el.hidden = false;
    if (!ok()) return;
    var h = el.scrollHeight;
    el.style.overflow = 'hidden';
    el._anim = el.animate(h > 1600 ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 220, easing: EASE });
    el._anim.onfinish = function () { el._anim = null; el.style.overflow = ''; };
  }

  function collapse(el) {
    stop(el);
    if (!ok() || el.hidden) { el.hidden = true; return; }
    var h = el.offsetHeight;
    if (h > 1600) { el.hidden = true; return; }
    el.style.overflow = 'hidden';
    el._anim = el.animate([{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 170, easing: 'ease-in' });
    el._anim.onfinish = function () { el._anim = null; el.hidden = true; el.style.overflow = ''; };
  }

  // Restart a one-shot CSS animation class (save star pop, highlight pulse).
  function replay(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // Page change: cross-fade/slide via the View Transitions API when available.
  // Can never get stuck: a new navigation skips the one in flight, the page update runs exactly
  // once (even if the transition is skipped, errors, or the browser refuses it), and a 1 s safety
  // net forces any transition that hasn't finished to complete.
  var current = null;
  function page(dir, fn) {
    var done = false;
    function run() {
      if (done) return;
      done = true;
      try { fn(); } catch (e) { console.error('Page update failed', e); }
    }
    if (current) { var old = current; current = null; try { old.skipTransition(); } catch (e) {} }
    if (!ok() || !document.startViewTransition || document.hidden) { run(); return; }
    var t;
    try {
      document.documentElement.setAttribute('data-dir', dir);
      t = document.startViewTransition(run);
    } catch (e) { run(); return; }
    current = t;
    var safety = setTimeout(function () {
      if (current === t) { current = null; try { t.skipTransition(); } catch (e) {} }
      run();
    }, 1000);
    function end() { clearTimeout(safety); if (current === t) current = null; run(); }
    t.finished.then(end, end);
    if (t.ready) t.ready.catch(function () {});
    if (t.updateCallbackDone) t.updateCallbackDone.catch(function () {});
  }

  // Bring a selected row/comment fully into view below the sticky header, with breathing room.
  // Tall items (or ones above the visible area) align to their top so the author line shows.
  function reveal(el, block) {
    if (!el) return;
    var pane = el.closest('.comments-pane');
    var box = pane ? pane.getBoundingClientRect() : null;
    var top = box ? box.top + 12 : headerBottom() + 12;
    var bottom = box ? box.bottom - 12 : window.innerHeight - 64;
    var r = el.getBoundingClientRect();
    var b = block === 'center' ? 'center'
      : r.top < top || r.height > bottom - top ? 'start'
      : r.bottom > bottom ? 'nearest' : null;
    if (b) el.scrollIntoView({ block: b, behavior: ok() ? 'smooth' : 'auto' });
  }

  // Keep --mast-h in sync with the pinned part of the sticky header so scroll-margin-top clears
  // it. On phones the brand row scrolls away (negative sticky top), so only the tabs count.
  var mast = document.querySelector('.mast');
  function mastH() {
    if (!mast) return 0;
    var top = parseFloat(getComputedStyle(mast).top) || 0;
    return mast.offsetHeight + Math.min(0, top);
  }
  function headerBottom() { return mast ? Math.max(0, mast.getBoundingClientRect().bottom) : 0; }
  function syncMast() { document.documentElement.style.setProperty('--mast-h', mastH() + 'px'); }
  if (mast && window.ResizeObserver) new ResizeObserver(syncMast).observe(mast);
  matchMedia('(max-width: 640px)').addEventListener('change', syncMast);
  syncMast();

  g.Anim = { ok: ok, expand: expand, collapse: collapse, replay: replay, page: page, reveal: reveal };
})(window);
