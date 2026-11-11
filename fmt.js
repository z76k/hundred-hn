/* ==== FORMAT: escaping, time, domains, in-reader HN links, safe HTML with markdown-style
   formatting for comments, plain markdown for reader view, and concurrency helpers. ==== */
(function (g) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function timeAgo(unixSec) {
    if (!unixSec) return '';
    var s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24); if (d < 30) return d + 'd ago';
    var mo = Math.floor(d / 30); if (mo < 12) return mo + 'mo ago';
    return Math.floor(d / 365) + 'y ago';
  }

  function fullDate(unixSec) {
    if (!unixSec) return '';
    return new Date(unixSec * 1000).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function domainOf(url) {
    if (!url) return '';
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* news.ycombinator.com item/user links -> in-reader routes. Returns null for other links. */
  function hnInternal(href) {
    try {
      var u = new URL(href, 'https://news.ycombinator.com/');
      if (!/^(www\.)?news\.ycombinator\.com$/i.test(u.hostname)) return null;
      var id = u.searchParams.get('id');
      if (u.pathname === '/item' && /^\d+$/.test(id || '')) {
        var frag = (u.hash || '').replace(/^#/, '');
        return '#/item/' + id + (/^\d+$/.test(frag) && frag !== id ? '/' + frag : '');
      }
      if (u.pathname === '/user' && id) return '#/user/' + encodeURIComponent(id);
    } catch (e) {}
    return null;
  }

  /* Attributes for an <a> pointing at url: in-reader route or new tab. */
  function linkAttrs(url) {
    var internal = hnInternal(url);
    if (internal) return 'href="' + esc(internal) + '"';
    return 'href="' + esc(url) + '" target="_blank" rel="noopener"';
  }

  /* ---------- Safe rendering of HN's HTML ---------- */
  var ALLOWED = { P: 1, A: 1, I: 1, EM: 1, B: 1, STRONG: 1, PRE: 1, CODE: 1, BR: 1 };

  function unwrap(el) {
    var parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    el.remove();
  }

  function setLink(a, href) {
    var abs = null;
    try { abs = new URL(href || '', 'https://news.ycombinator.com/').href; } catch (e) {}
    if (!abs || !/^https?:/i.test(abs)) return false;
    var internal = hnInternal(abs);
    if (internal) {
      a.setAttribute('href', internal);
      a.setAttribute('data-internal', '');
    } else {
      a.setAttribute('href', abs);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    return true;
  }

  function cleanNode(node) {
    Array.prototype.slice.call(node.childNodes).forEach(function (child) {
      if (child.nodeType === 3) return;
      if (child.nodeType !== 1) { child.remove(); return; }
      var tag = child.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT') { child.remove(); return; }
      cleanNode(child);
      if (!ALLOWED[tag]) { unwrap(child); return; }
      var href = tag === 'A' ? child.getAttribute('href') : null;
      Array.prototype.slice.call(child.attributes).forEach(function (a) { child.removeAttribute(a.name); });
      if (tag === 'A' && !setLink(child, href)) unwrap(child);
    });
  }

  function firstText(node) {
    if (!node) return null;
    if (node.nodeType === 3) return node;
    if (node.tagName === 'A' || node.tagName === 'CODE') return null;
    for (var c = node.firstChild; c; c = c.nextSibling) {
      var t = firstText(c);
      if (t) return t;
      if (c.nodeType === 3 || c.textContent) return null;
    }
    return null;
  }

  /* Remove a leading pattern (e.g. "> " or "- ") from the start of a run of nodes. */
  function stripLead(nodes, re) {
    for (var i = 0; i < nodes.length; i++) {
      var t = firstText(nodes[i]);
      if (t) { t.textContent = t.textContent.replace(re, ''); return; }
      if (nodes[i].textContent) return;
    }
  }

  /* Split block content into lines, each a run of nodes, breaking on "\n" and <br>. */
  function toLines(nodes, doc) {
    var lines = [[]];
    nodes.forEach(function (n) {
      if (n.nodeType === 1 && n.tagName === 'BR') { lines.push([]); return; }
      if (n.nodeType === 3 && n.textContent.indexOf('\n') >= 0) {
        n.textContent.split('\n').forEach(function (part, i) {
          if (i > 0) lines.push([]);
          if (part) lines[lines.length - 1].push(doc.createTextNode(part));
        });
        return;
      }
      lines[lines.length - 1].push(n);
    });
    return lines.map(function (ns) {
      return { nodes: ns, text: ns.map(function (x) { return x.textContent; }).join('') };
    }).filter(function (l) { return l.text.trim() || l.nodes.some(function (x) { return x.nodeType === 1; }); });
  }

  var RE_UL = /^\s*[-*]\s+(?=\S)/;
  var RE_OL = /^\s*(\d{1,3})[.)]\s+(?=\S)/;
  var RE_QUOTE = /^\s*>/;
  var RE_FENCE = /^\s*```/;

  function appendLine(el, line, doc, first) {
    if (!first) el.appendChild(doc.createTextNode('\n'));
    line.nodes.forEach(function (n) { el.appendChild(n); });
  }

  /* Turn a flat list of lines (tagged with paragraph index) into blocks. */
  function buildBlocks(items, doc, md) {
    var out = doc.createElement('div');
    var i = 0;
    while (i < items.length) {
      var it = items[i];
      if (it.pre) { out.appendChild(it.pre); i++; continue; }

      // Fenced code block: ``` … ``` (only when a closing fence exists).
      if (md && RE_FENCE.test(it.text)) {
        var t0 = it.text.trim();
        var end = -1, single = false;
        if (t0.length > 6 && /```$/.test(t0)) { end = i; single = true; }
        else for (var j = i + 1; j < items.length; j++) {
          if (items[j].pre) break;
          if (/```\s*$/.test(items[j].text)) { end = j; break; }
        }
        if (end >= 0) {
          var code;
          if (single) {
            code = t0.slice(3, -3);
          } else {
            code = it.text.replace(/^\s*```[\w+#.-]*[ \t]*/, '');
            for (var k = i + 1; k <= end; k++) {
              code += (items[k].para === items[k - 1].para ? '\n' : '\n\n') + items[k].text;
            }
            code = code.replace(/```\s*$/, '');
          }
          var pre = doc.createElement('pre');
          var c = doc.createElement('code');
          c.textContent = code.replace(/^\n+|\s+$/g, '');
          pre.appendChild(c);
          out.appendChild(pre);
          i = end + 1;
          continue;
        }
      }

      // Lists: two or more consecutive "- ", "* " or "1. " lines.
      if (md && (RE_UL.test(it.text) || RE_OL.test(it.text))) {
        var ordered = !RE_UL.test(it.text);
        var re = ordered ? RE_OL : RE_UL;
        var run = [];
        for (var m = i; m < items.length && !items[m].pre && re.test(items[m].text); m++) run.push(items[m]);
        if (run.length >= 2) {
          var list = doc.createElement(ordered ? 'ol' : 'ul');
          if (ordered) {
            var start = parseInt(RE_OL.exec(run[0].text)[1], 10);
            if (start !== 1) list.setAttribute('start', String(start));
          }
          run.forEach(function (line) {
            var li = doc.createElement('li');
            stripLead(line.nodes, re);
            appendLine(li, line, doc, true);
            list.appendChild(li);
          });
          out.appendChild(list);
          i += run.length;
          continue;
        }
      }

      // Quotes: consecutive lines starting with ">".
      if (RE_QUOTE.test(it.text)) {
        var bq = doc.createElement('blockquote');
        var p = null, lastPara = null;
        while (i < items.length && !items[i].pre && RE_QUOTE.test(items[i].text)) {
          var q = items[i];
          stripLead(q.nodes, /^\s*>\s?/);
          if (q.para !== lastPara) { p = doc.createElement('p'); bq.appendChild(p); appendLine(p, q, doc, true); }
          else appendLine(p, q, doc, false);
          lastPara = q.para;
          i++;
        }
        out.appendChild(bq);
        continue;
      }

      // Plain paragraph: consecutive ordinary lines from the same source paragraph.
      var para = doc.createElement('p');
      var pi = it.para, firstLine = true;
      while (i < items.length && !items[i].pre && items[i].para === pi && !RE_QUOTE.test(items[i].text) &&
        !(md && !firstLine && (RE_FENCE.test(items[i].text) || RE_UL.test(items[i].text) || RE_OL.test(items[i].text)))) {
        appendLine(para, items[i], doc, firstLine);
        firstLine = false;
        i++;
      }
      out.appendChild(para);
    }
    return out;
  }

  /* HN turns *x* into <i>. Repair its output where people meant **bold** or math like 2*3*4. */
  function fixHnItalics(root, doc) {
    Array.prototype.slice.call(root.querySelectorAll('i, em')).forEach(function (el) {
      if (el.closest('pre, code, a')) return;
      var prev = el.previousSibling, next = el.nextSibling;
      var prevT = prev && prev.nodeType === 3 ? prev : null;
      var nextT = next && next.nodeType === 3 ? next : null;
      var inner = el.textContent;
      var ft = firstText(el), lt = el.lastChild && el.lastChild.nodeType === 3 ? el.lastChild : null;
      var toBold = false;

      if (inner.length > 2 && inner[0] === '*' && inner[inner.length - 1] === '*' && ft && lt) {
        ft.textContent = ft.textContent.replace(/^\*/, ''); lt.textContent = lt.textContent.replace(/\*$/, ''); toBold = true;
      } else if (ft && inner[0] === '*' && nextT && nextT.textContent[0] === '*') {
        ft.textContent = ft.textContent.replace(/^\*/, ''); nextT.textContent = nextT.textContent.slice(1); toBold = true;
      } else if (lt && inner[inner.length - 1] === '*' && prevT && /\*$/.test(prevT.textContent)) {
        lt.textContent = lt.textContent.replace(/\*$/, ''); prevT.textContent = prevT.textContent.slice(0, -1); toBold = true;
      } else if (prevT && nextT && /\*$/.test(prevT.textContent) && nextT.textContent[0] === '*') {
        prevT.textContent = prevT.textContent.slice(0, -1); nextT.textContent = nextT.textContent.slice(1); toBold = true;
      } else if (prevT && nextT && /[\w)\]]$/.test(prevT.textContent) && /^[\w(\[]/.test(nextT.textContent) &&
        /^[^\s]+$/.test(inner) && el.children.length === 0) {
        // 2<i>3</i>4  ->  2*3*4
        el.replaceWith(doc.createTextNode('*' + inner + '*'));
        return;
      }
      if (toBold) {
        var b = doc.createElement('strong');
        while (el.firstChild) b.appendChild(el.firstChild);
        el.replaceWith(b);
      }
    });
  }

  // Inline markdown tokens, tried left to right within a single text node.
  var RE_INLINE = new RegExp([
    '(`[^`\\n]+`)',                                                           // 1 inline code
    '(\\bhttps?:\\/\\/[^\\s<>"\']+)',                                          // 2 bare link
    '((?<![\\w*])\\*\\*(?=\\S)[^*\\n]*?[^\\s*]\\*\\*(?![\\w*]))',              // 3 bold
    '((?<![\\w*])\\*(?=[^\\s*])[^*\\n]*?[^\\s*]\\*(?![\\w*])|(?<![\\w*])\\*[^\\s*]\\*(?![\\w*]))' // 4 italic
  ].join('|'), 'g');

  function inlineText(node, doc) {
    var s = node.textContent;
    RE_INLINE.lastIndex = 0;
    if (!RE_INLINE.test(s)) return;
    RE_INLINE.lastIndex = 0;
    var frag = doc.createDocumentFragment();
    var last = 0, m;
    while ((m = RE_INLINE.exec(s))) {
      var tok = m[0], el = null, trail = '';
      if (m[1]) {
        el = doc.createElement('code'); el.textContent = tok.slice(1, -1);
      } else if (m[2]) {
        var url = tok;
        while (/[.,;:!?'"]$/.test(url) || (/\)$/.test(url) && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) {
          trail = url.slice(-1) + trail; url = url.slice(0, -1);
        }
        el = doc.createElement('a');
        if (!setLink(el, url)) { el = null; }
        else el.textContent = url;
        if (!el) { trail = ''; }
      } else if (m[3]) {
        el = doc.createElement('strong'); el.textContent = tok.slice(2, -2);
      } else if (m[4]) {
        el = doc.createElement('em'); el.textContent = tok.slice(1, -1);
      }
      if (!el) continue;
      if (m.index > last) frag.appendChild(doc.createTextNode(s.slice(last, m.index)));
      frag.appendChild(el);
      if (trail) frag.appendChild(doc.createTextNode(trail));
      last = m.index + tok.length;
    }
    if (last === 0) return;
    if (last < s.length) frag.appendChild(doc.createTextNode(s.slice(last)));
    node.replaceWith(frag);
  }

  function inlinePass(root, doc) {
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.parentNode && n.parentNode.closest && n.parentNode.closest('a, code, pre')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) { inlineText(n, doc); });
  }

  function richHTML(html, opts) {
    if (!html) return '';
    var md = opts && opts.md != null ? opts.md : Store.pref('md');
    var doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
    var root = doc.getElementById('r');
    if (!root) return '';
    cleanNode(root);
    if (md) fixHnItalics(root, doc);

    // HN leaves the first paragraph unwrapped; collect paragraphs, then lines.
    var paras = [], loose = [];
    function flush() { if (loose.length) { paras.push({ nodes: loose }); loose = []; } }
    Array.prototype.slice.call(root.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && n.tagName === 'P') { flush(); paras.push({ nodes: Array.prototype.slice.call(n.childNodes) }); }
      else if (n.nodeType === 1 && n.tagName === 'PRE') { flush(); paras.push({ pre: n }); }
      else loose.push(n);
    });
    flush();

    var items = [];
    paras.forEach(function (p, idx) {
      if (p.pre) { items.push({ pre: p.pre, para: idx }); return; }
      toLines(p.nodes, doc).forEach(function (l) { l.para = idx; items.push(l); });
    });

    var out = buildBlocks(items, doc, md);
    if (md) inlinePass(out, doc);
    return out.innerHTML;
  }

  /* ---------- Concurrency ---------- */
  function pool(items, limit, worker) {
    var i = 0;
    var results = new Array(items.length);
    function next() {
      if (i >= items.length) return Promise.resolve();
      var idx = i++;
      return Promise.resolve()
        .then(function () { return worker(items[idx], idx); })
        .then(function (r) { results[idx] = r; }, function (e) { results[idx] = { __error: e }; })
        .then(next);
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(next());
    return Promise.all(runners).then(function () { return results; });
  }

  function timeout(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* ---------- Plain markdown -> safe HTML (reader view articles) ---------- */
  function mdInline(s) {
    return esc(s)
      .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img alt="$1" src="$2" loading="lazy" referrerpolicy="no-referrer">')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, function (m, t, u) {
        var internal = hnInternal(u.replace(/&amp;/g, '&'));
        return internal ? '<a href="' + internal + '">' + t + '</a>' : '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
      })
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1<em>$2</em>');
  }

  function mdToHTML(src) {
    var lines = String(src || '').replace(/\r/g, '').split('\n'), out = [], i = 0;
    while (i < lines.length) {
      var l = lines[i];
      if (/^\s*```/.test(l)) {
        var code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        i++; continue;
      }
      var h = /^(#{1,6})\s+(.*)/.exec(l);
      if (h) { var n = Math.min(h[1].length + 1, 6); out.push('<h' + n + '>' + mdInline(h[2]) + '</h' + n + '>'); i++; continue; }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        var ol = /^\s*\d/.test(l), items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push('<li>' + mdInline(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '')) + '</li>');
        out.push((ol ? '<ol>' : '<ul>') + items.join('') + (ol ? '</ol>' : '</ul>'));
        continue;
      }
      if (/^\s*>/.test(l)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote><p>' + mdInline(q.join(' ')) + '</p></blockquote>');
        continue;
      }
      if (!l.trim() || /^\s*([-*_]\s*){3,}$/.test(l)) { i++; continue; }
      var p = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) p.push(lines[i++]);
      out.push('<p>' + mdInline(p.join(' ')) + '</p>');
    }
    return out.join('');
  }

  g.U = {
    esc: esc, timeAgo: timeAgo, fullDate: fullDate, domainOf: domainOf, plural: plural,
    richHTML: richHTML, mdToHTML: mdToHTML, pool: pool, timeout: timeout, hnInternal: hnInternal, linkAttrs: linkAttrs
  };
})(window);
