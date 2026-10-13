/*
 * sigakhwa-click — Hermes WebUI extension (id: sigakhwa-click). Owner: Engineer A.
 *
 * 1. Clickable diagram boxes: an assistant reply that contains a Mermaid flowchart plus a fenced
 *    ```sigakhwa-actions JSON block (README: How a reply makes boxes clickable) gets its listed nodes bound. Clicking a
 *    bound <g class="node"> opens a confirmation before sending the node's prompt ONCE to the same conversation + active profile
 *    through window.HermesVizSend (shared/hermes-viz-send.js → core send(), the Enter path).
 * 2. Selection quick-ask: selecting text inside a settled assistant row shows a small floating
 *    toolbar (쉽게 설명 / 근거 확인 / 시각화 / 대안 비교, README: How a reply makes boxes clickable); a button click sends
 *    the template through the same module and collapses the selection.
 *
 * Zero core edits. Core DOM surface used (pinned upstream, see README: WebUI surfaces used):
 *   #msgInner transcript container; .assistant-segment[data-msg-idx][data-session-msg-idx]
 *   (settled assistant rows, inside .msg-row.assistant-turn[data-session-id]); live rows are
 *   #liveAssistantTurn / [data-live-assistant-turn="1"] / [data-live-assistant="1"];
 *   .mermaid-block → .mermaid-rendered > .mermaid-viewer > .mermaid-viewer-viewport > svg
 *   (ui.js renderMermaidBlocks + _mountMermaidViewer); fenced blocks render as
 *   <div class="pre-header">lang</div><pre><code class="language-lang">; the lightbox is
 *   .img-lightbox holding a cloneNode(true) copy of the svg (_openMermaidLightbox).
 *
 * Safety rules implemented here: fail-closed schema parser, only `prompt` actions, bound to the
 * render-time session/profile and re-validated at click time, one document-level capture-phase
 * click listener, synthetic (untrusted) events ignored, no innerHTML with model text, bounded
 * linear regexes only, MutationObserver scoped to #msgInner and paused during our own DOM writes.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.SigakhwaClick && window.SigakhwaClick.version >= 1) return;

  var EXT_ID = 'sigakhwa-click';
  var VERSION = 1;
  var MAX_NODES = 12;
  var MAX_PROMPT = 500;
  var MAX_LABEL = 20;
  var MAX_BLOCK_CHARS = 16 * 1024;   // a sane upper bound for the raw JSON block
  var MAX_DIAGRAM_INDEX = 99;
  var MAX_SELECTION = 1000;
  var MAX_SEND = 2000;               // HermesVizSend text cap
  var DRAG_SLOP_PX = 8;              // pointer travel beyond this is a pan, not a click
  var POINTER_MEMORY_MS = 1500;
  var KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;        // node id (bounded, linear)
  var CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/; // control chars except \t \n \r
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var ATTR = {
    prompt: 'data-sigakhwa-prompt',
    sid: 'data-sigakhwa-sid',
    profile: 'data-sigakhwa-profile',
    msg: 'data-sigakhwa-msg',
    label: 'data-sigakhwa-label',
    state: 'data-sigakhwa-state'
  };
  var CLS = {
    bound: 'sigakhwa-click-bound',
    badge: 'sigakhwa-click-badge',
    title: 'sigakhwa-click-title',
    hidden: 'sigakhwa-click-hidden',
    caption: 'sigakhwa-click-caption',
    captionEmpty: 'sigakhwa-click-caption--empty',
    captionIcon: 'sigakhwa-click-caption-icon',
    captionText: 'sigakhwa-click-caption-text',
    captionToggle: 'sigakhwa-click-caption-toggle',
    toolbar: 'sigakhwa-click-toolbar',
    toolbarVisible: 'is-visible',
    flash: 'sigakhwa-click-flash'
  };
  var SEL_ROW = '.assistant-segment[data-msg-idx], .msg-row[data-msg-idx]';
  var SEL_LIVE = '#liveAssistantTurn, [data-live-assistant-turn="1"], [data-live-assistant="1"]';
  var SEL_DIAGRAM = '.mermaid-block, .mermaid-rendered';
  var SEL_ACTIONS_CODE = 'pre > code.language-sigakhwa-actions';

  // UI strings and fixed quick-ask templates follow Core's locale.
  var STRINGS = { ko: {
    captionBound: function (n) { return '클릭 가능한 상자 ' + n + '개 · 상자를 누르면 보낼 질문을 확인한 뒤 전송할 수 있습니다'; },
    captionNone: '클릭 가능한 상자 0개 · 도식과 연결된 상자를 찾지 못했습니다',
    showJson: 'JSON 보기',
    hideJson: 'JSON 숨기기',
    nodeTitle: function (prompt, label) { return (label ? label + ' — ' : '') + '누르면 보낼 질문을 확인합니다'; },
    toolbarLabel: '선택한 내용으로 질문하기',
    moduleMissing: '전송 모듈(HermesVizSend)을 찾을 수 없습니다 — 확장 설치를 확인하세요',
    send: '보내기', cancel: '취소', notice: '이 질문을 이 대화에 보냅니다',
    draft: '입력창의 초안을 먼저 보내거나 지워 주세요',
    explainLabel: '쉽게 설명', evidenceLabel: '근거 확인', visualizeLabel: '시각화', compareLabel: '대안 비교',
    explainPrompt: '다음 부분을 더 쉽게 설명해줘:\n\n',
    evidencePrompt: '다음 내용의 근거를 확인해줘. 출처나 근거를 댈 수 없으면 그렇게 말해줘:\n\n',
    visualizePrompt: '시각화\n\n',
    comparePrompt: '다음 내용에 대한 대안 2~3개를 비교해줘:\n\n'
  }, en: {
    captionBound: function (n) { return n + ' clickable boxes · Tap a box to review its question'; },
    captionNone: '0 clickable boxes · No matching diagram boxes found',
    showJson: 'Show JSON', hideJson: 'Hide JSON',
    nodeTitle: function (prompt, label) { return (label ? label + ' — ' : '') + 'Tap to review the question before sending'; },
    toolbarLabel: 'Ask about selected text',
    moduleMissing: 'Send module (HermesVizSend) unavailable — check the extension installation',
    send: 'Send', cancel: 'Cancel', notice: 'This question will be sent to this conversation',
    draft: 'Send or clear your draft first',
    explainLabel: 'Explain simply', evidenceLabel: 'Check evidence', visualizeLabel: 'Visualize', compareLabel: 'Compare alternatives',
    explainPrompt: 'Explain the following more simply:\n\n',
    evidencePrompt: 'Check the evidence for the following. If you cannot provide sources or evidence, say so:\n\n',
    visualizePrompt: 'Visualize\n\n',
    comparePrompt: 'Compare 2–3 alternatives for the following:\n\n'
  } };
  function t(key) {
    var lang = typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : '';
    lang = String(lang || '').toLowerCase();
    return STRINGS[lang.indexOf('ko') === 0 ? 'ko' : 'en'][key];
  }

  // §5 templates. {sel} is quoted as a markdown blockquote.
  var TEMPLATES = [
    { key: 'explain' }, { key: 'evidence' }, { key: 'visualize' }, { key: 'compare' }
  ];

  // ── small helpers ────────────────────────────────────────────────────────
  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement || null;
  }
  function closest(node, sel) {
    var el = elementOf(node);
    return (el && el.closest) ? el.closest(sel) : null;
  }
  function toast(msg, ms, type) {
    try { if (typeof showToast === 'function') { showToast(msg, ms, type); return; } } catch (_) {}
    try { if (typeof window.showToast === 'function') window.showToast(msg, ms, type); } catch (_) {}
  }
  function sendModule() {
    var m = window.HermesVizSend;
    return (m && m.version >= 1 && typeof m.send === 'function') ? m : null;
  }
  function isLive(el) {
    return !!closest(el, SEL_LIVE);
  }
  function transcriptRoot() {
    return document.getElementById('msgInner');
  }

  // ── §4 schema parser (pure, fail closed) ─────────────────────────────────
  // parseActions(rawJsonText, knownNodeIds?) →
  //   { ok:false, reason } | { ok:true, diagram:number|null, nodes:[{id,prompt,label}], dropped:number }
  // Structural violations (not JSON, v!==1, nodes missing/empty/>12, bad diagram index) ignore the
  // whole block. Per-node violations (bad id, non-string/empty/>500-char prompt, leading "/",
  // control chars, id not in knownNodeIds when given) drop that node only; a block whose nodes
  // are all dropped is ignored. Unknown fields (url, js, href, onclick, …) are never read.
  function parseActions(raw, knownNodeIds) {
    if (typeof raw !== 'string') return { ok: false, reason: 'not_string' };
    var text = raw.trim();
    if (!text) return { ok: false, reason: 'empty' };
    if (text.length > MAX_BLOCK_CHARS) return { ok: false, reason: 'too_large' };
    var data;
    try { data = JSON.parse(text); } catch (_) { return { ok: false, reason: 'not_json' }; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'not_object' };
    if (data.v !== 1) return { ok: false, reason: 'version' };
    var nodes = data.nodes;
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return { ok: false, reason: 'nodes' };
    var keys = Object.keys(nodes);
    if (!keys.length) return { ok: false, reason: 'no_nodes' };
    if (keys.length > MAX_NODES) return { ok: false, reason: 'too_many_nodes' };
    var diagram = null;
    if (data.diagram !== undefined) {
      if (typeof data.diagram !== 'number' || !isFinite(data.diagram) || Math.floor(data.diagram) !== data.diagram
          || data.diagram < 0 || data.diagram > MAX_DIAGRAM_INDEX) return { ok: false, reason: 'diagram' };
      diagram = data.diagram;
    }
    var known = null;
    if (Array.isArray(knownNodeIds)) {
      // Prototype-free: a node id such as "constructor" or "__proto__" must not inherit membership.
      known = Object.create(null);
      for (var k = 0; k < knownNodeIds.length; k++) known[String(knownNodeIds[k])] = true;
    }
    var out = [];
    var dropped = 0;
    for (var i = 0; i < keys.length; i++) {
      var id = keys[i];
      var entry = nodes[id];
      if (!KEY_RE.test(id) || (known && !known[id])) { dropped++; continue; }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { dropped++; continue; }
      var prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
      if (!prompt || prompt.length > MAX_PROMPT || prompt.charAt(0) === '/' || CONTROL_RE.test(prompt)) { dropped++; continue; }
      var label = null;
      if (typeof entry.label === 'string') {
        var l = entry.label.trim();
        if (l && l.length <= MAX_LABEL && !CONTROL_RE.test(l)) label = l;   // invalid label → just ignored
      }
      out.push({ id: id, prompt: prompt, label: label });
    }
    if (!out.length) return { ok: false, reason: 'no_valid_nodes', dropped: dropped };
    return { ok: true, diagram: diagram, nodes: out, dropped: dropped };
  }

  // Mermaid 10 flowchart node ids are "flowchart-<NodeId>-<n>"; the numeric suffix is NOT stable.
  function nodeIdFromDomId(domId) {
    var s = String(domId || '');
    if (s.indexOf('flowchart-') !== 0) return null;
    s = s.slice('flowchart-'.length);
    var m = /^(.*)-\d+$/.exec(s);      // bounded by the id's own length; ids are short
    if (!m) return null;
    return m[1] || null;
  }
  function indexSvgNodes(svg) {
    var map = Object.create(null);   // prototype-free lookup (see parseActions)
    var ids = [];
    if (!svg || !svg.querySelectorAll) return { map: map, ids: ids };
    var gs = svg.querySelectorAll('g.node[id]');
    for (var i = 0; i < gs.length; i++) {
      var id = nodeIdFromDomId(gs[i].getAttribute('id'));
      if (!id || map[id]) continue;
      map[id] = gs[i];
      ids.push(id);
    }
    return { map: map, ids: ids };
  }

  // ── §5 templates (pure) ──────────────────────────────────────────────────
  function normalizeSelection(s) {
    return String(s || '').slice(0, 4000)
      .replace(/ /g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, function (run, off, str) { return str.charAt(off + run.length) === '\n' ? '' : run; })
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function clipText(s, max) {
    var t = normalizeSelection(s);
    if (t.length <= max) return t;
    return t.slice(0, max - 1).replace(/\s+$/, '') + '…';
  }
  function quote(s) {
    return s.split('\n').map(function (line) { return '> ' + line; }).join('\n');
  }
  function templateByKey(key) {
    for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].key === key) return TEMPLATES[i];
    return null;
  }
  // renderTemplate(key, selectedText) → string | null. Selection is trimmed to ≤1000 chars and the
  // whole message is kept ≤2000 chars (blockquote prefixes add up on many short lines).
  function renderTemplate(key, selection) {
    var tpl = templateByKey(key);
    if (!tpl) return null;
    var budget = MAX_SELECTION;
    var sel = clipText(selection, budget);
    if (!sel) return null;
    var out = t(key + 'Prompt') + quote(sel);
    var guard = 0;
    while (out.length > MAX_SEND && budget > 40 && guard++ < 12) {
      budget = Math.floor(budget * 0.8);
      sel = clipText(selection, budget);
      out = t(key + 'Prompt') + quote(sel);
    }
    return out.length <= MAX_SEND ? out : null;
  }

  // ── binding: actions block → svg nodes ───────────────────────────────────
  function captureTarget(seg) {
    var mod = sendModule();
    var cur = mod ? mod.currentTarget() : null;
    var turn = closest(seg, '.assistant-turn');
    var sid = (turn && turn.getAttribute('data-session-id')) || (cur && cur.sessionId) || '';
    if (!sid) return null;
    return {
      sessionId: String(sid),
      profile: String((cur && cur.profile) || 'default'),
      msg: String(seg.getAttribute('data-session-msg-idx') || seg.getAttribute('data-msg-idx') || '')
    };
  }
  function precedes(a, b) {
    try { return !!(a.compareDocumentPosition(b) & 4); } catch (_) { return false; } // 4 = DOCUMENT_POSITION_FOLLOWING
  }
  function pickDiagram(diagrams, pre, explicitIndex) {
    if (explicitIndex !== null && explicitIndex !== undefined) return diagrams[explicitIndex] || null;
    for (var i = diagrams.length - 1; i >= 0; i--) if (precedes(diagrams[i], pre)) return diagrams[i];
    return null;
  }
  // The rendered Mermaid <svg> — NOT the first <svg> in the block. Core's _mountMermaidViewer
  // (ui.js:2243-2244) appends the toolbar BEFORE the viewport, and every toolbar button carries an
  // inline <svg> icon (ui.js:2160-2183), so `diagram.querySelector('svg')` would return the zoom-in
  // icon. Prefer the viewport/marked svg; otherwise take the first svg outside the toolbar that
  // actually contains flowchart nodes (covers a core without the viewer wrapper).
  function pickDiagramSvg(diagram) {
    if (!diagram || !diagram.querySelector) return null;
    var svg = diagram.querySelector('.mermaid-viewer-viewport svg, svg.mermaid-viewer-svg');
    if (svg) return svg;
    var all = diagram.querySelectorAll('svg');
    for (var i = 0; i < all.length; i++) {
      if (closest(all[i], '.mermaid-viewer-toolbar, button')) continue;
      if (all[i].querySelector && all[i].querySelector('g.node')) return all[i];
    }
    return null;
  }

  function setNodeTitle(g, text) {
    var old = g.querySelector(':scope > title.' + CLS.title);
    if (old) old.remove();
    var title = document.createElementNS(SVG_NS, 'title');
    title.setAttribute('class', CLS.title);
    title.textContent = text;
    g.insertBefore(title, g.firstChild);
  }
  function addBadge(g) {
    var old = g.querySelector(':scope > g.' + CLS.badge);
    if (old) old.remove();
    var box = null;
    try { if (typeof g.getBBox === 'function') box = g.getBBox(); } catch (_) { box = null; }
    if (!box || !isFinite(box.width) || !box.width) {
      // jsdom / not-yet-laid-out fallback: Mermaid centres the shape at the g origin
      var rect = g.querySelector(':scope > rect, :scope > polygon, :scope > circle, :scope > path, .label-container');
      var w = rect && parseFloat(rect.getAttribute('width'));
      var h = rect && parseFloat(rect.getAttribute('height'));
      if (!isFinite(w) || !isFinite(h) || !w || !h) return;
      box = { x: -w / 2, y: -h / 2, width: w, height: h };
    }
    var badge = document.createElementNS(SVG_NS, 'g');
    badge.setAttribute('class', CLS.badge);
    badge.setAttribute('aria-hidden', 'true');
    badge.setAttribute('transform', 'translate(' + (box.x + box.width - 2) + ',' + (box.y + 2) + ')');
    var circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', '8');
    var text = document.createElementNS(SVG_NS, 'text');
    text.textContent = '?';
    badge.appendChild(circle);
    badge.appendChild(text);
    g.appendChild(badge);
  }

  function bindNodes(svg, nodes, bound) {
    var idx = indexSvgNodes(svg);
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var g = idx.map[n.id];
      if (!g) continue;
      count++;
      var same = g.getAttribute(ATTR.prompt) === n.prompt && g.getAttribute(ATTR.sid) === bound.sessionId
        && g.getAttribute(ATTR.profile) === bound.profile && g.classList.contains(CLS.bound);
      if (same) continue;                       // idempotent re-bind
      g.setAttribute(ATTR.prompt, n.prompt);
      g.setAttribute(ATTR.sid, bound.sessionId);
      g.setAttribute(ATTR.profile, bound.profile);
      g.setAttribute(ATTR.msg, bound.msg);
      if (n.label) g.setAttribute(ATTR.label, n.label); else g.removeAttribute(ATTR.label);
      g.classList.add(CLS.bound);
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', t('nodeTitle')(n.prompt, n.label));
      setNodeTitle(g, t('nodeTitle')(n.prompt, n.label));
      addBadge(g);
    }
    return { count: count, available: idx.ids };
  }

  function collapseBlock(pre, count) {
    var header = pre.previousElementSibling;
    if (header && !(header.classList && header.classList.contains('pre-header'))) header = null;
    if (pre.previousElementSibling && pre.previousElementSibling.classList
        && pre.previousElementSibling.classList.contains(CLS.caption)) return; // already collapsed
    var caption = document.createElement('div');
    caption.className = CLS.caption + (count ? '' : ' ' + CLS.captionEmpty);
    caption.setAttribute('data-sigakhwa-caption', '1');
    var icon = document.createElement('span');
    icon.className = CLS.captionIcon;
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '?';
    var text = document.createElement('span');
    text.className = CLS.captionText;
    text.textContent = count ? t('captionBound')(count) : t('captionNone');
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = CLS.captionToggle;
    toggle.textContent = t('showJson');
    toggle.setAttribute('aria-expanded', 'false');
    containActivationKeys(toggle);
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var hidden = pre.classList.toggle(CLS.hidden);
      if (header) header.classList.toggle(CLS.hidden, hidden);
      toggle.textContent = hidden ? t('showJson') : t('hideJson');
      toggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    });
    caption.appendChild(icon);
    caption.appendChild(text);
    caption.appendChild(toggle);
    pre.classList.add(CLS.hidden);
    if (header) header.classList.add(CLS.hidden);
    var anchor = header || pre;
    anchor.parentNode.insertBefore(caption, anchor);
  }

  // Bind one settled assistant row. Returns the number of actions blocks bound in this pass.
  function bindSegment(seg) {
    if (!seg || !seg.isConnected || !seg.querySelectorAll) return 0;
    if (isLive(seg)) return 0;
    var root = transcriptRoot();
    if (root && !root.contains(seg)) return 0;
    var codes = seg.querySelectorAll(SEL_ACTIONS_CODE);
    if (!codes.length) return 0;
    var diagrams = Array.prototype.slice.call(seg.querySelectorAll(SEL_DIAGRAM));
    var boundBlocks = 0;
    for (var c = 0; c < codes.length; c++) {
      var code = codes[c];
      var pre = code.parentElement;
      var state = pre.getAttribute(ATTR.state);
      if (state === 'bound' || state === 'invalid') continue;
      // Pass 1 (structure only) decides which diagram the block refers to.
      var parsed = parseActions(code.textContent, null);
      if (!parsed.ok) { pre.setAttribute(ATTR.state, 'invalid'); continue; }   // raw block stays visible
      var diagram = pickDiagram(diagrams, pre, parsed.diagram);
      if (!diagram) { pre.setAttribute(ATTR.state, 'invalid'); continue; }
      var svg = pickDiagramSvg(diagram);
      if (!svg || !diagram.classList.contains('mermaid-rendered')) continue;   // not rendered yet → retry on mutation
      var available = indexSvgNodes(svg).ids;
      // An svg with no flowchart nodes yet (still rendering, or a non-flowchart diagram) is never
      // marked invalid: leave the block untouched and re-check on the next mutation of this row.
      if (!available.length) continue;
      // Pass 2 validates every key against the rendered diagram's node ids (fail closed: a block
      // whose keys match nothing is ignored and stays a plain code block).
      parsed = parseActions(code.textContent, available);
      if (!parsed.ok) { pre.setAttribute(ATTR.state, 'invalid'); continue; }
      var bound = captureTarget(seg);
      if (!bound) continue;
      var res = bindNodes(svg, parsed.nodes, bound);
      collapseBlock(pre, res.count);
      pre.setAttribute(ATTR.state, 'bound');
      boundBlocks++;
    }
    return boundBlocks;
  }

  // ── observer (scoped to #msgInner, paused during our own writes) ─────────
  var observer = null;
  var pendingSegs = [];
  var pendingSet = typeof Set === 'function' ? new Set() : null;
  var flushRaf = 0;

  function queueSegment(seg) {
    if (!seg) return;
    if (pendingSet) { if (pendingSet.has(seg)) return; pendingSet.add(seg); }
    pendingSegs.push(seg);
  }
  function onMutations(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var target = elementOf(r.target);
      if (target && target.closest && target.closest('[data-sigakhwa-caption], .' + CLS.toolbar)) continue; // our own
      var seg = target && target.closest ? target.closest('[data-msg-idx]') : null;
      if (seg) queueSegment(seg);
      var added = r.addedNodes || [];
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (!n || n.nodeType !== 1) continue;
        var own = n.closest ? n.closest('[data-msg-idx]') : null;
        if (own) queueSegment(own);
        if (n.querySelectorAll) {
          var inner = n.querySelectorAll('[data-msg-idx]');
          for (var k = 0; k < inner.length; k++) queueSegment(inner[k]);
        }
      }
    }
    if (pendingSegs.length) scheduleFlush();
  }
  function scheduleFlush() {
    if (flushRaf) return;
    var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
    flushRaf = raf(flush);
  }
  // ── core workaround: duplicate Mermaid render ids ─────────────────────────
  // Core caches rendered markdown by content, so two replies with an identical ```mermaid block get the
  // SAME data-mermaid-id; mermaid.render() then fails for the second one and core falls back to a code
  // block (reproduced on the pinned upstream with no extension loaded). Repair only that case: a failed
  // block (core fallback: no .mermaid-block, data-rendered set, "mermaid" pre-header) whose id is shared
  // with another block gets a fresh id and is handed back to core's own renderMermaidBlocks() ONCE.
  // A genuinely invalid diagram has a unique id and is left as code.
  var RETRY_ATTR = 'data-sigakhwa-mermaid-retry';
  var MERMAID_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  function coreRenderMermaid() {
    try { if (typeof renderMermaidBlocks === 'function') return renderMermaidBlocks; } catch (_) {}
    return typeof window.renderMermaidBlocks === 'function' ? window.renderMermaidBlocks : null;
  }
  function repairDuplicateMermaid(scope) {
    var render = coreRenderMermaid();
    if (!render || !scope || !scope.querySelectorAll) return 0;
    var failed = scope.querySelectorAll('[data-mermaid-id][data-rendered]:not(.mermaid-block):not([' + RETRY_ATTR + '])');
    var n = 0;
    for (var i = 0; i < failed.length; i++) {
      var block = failed[i];
      var id = block.getAttribute('data-mermaid-id') || '';
      if (!MERMAID_ID_RE.test(id)) continue;
      var header = block.querySelector(':scope > .pre-header');
      var code = block.querySelector(':scope > pre > code');
      if (!header || !code || header.textContent.trim().toLowerCase() !== 'mermaid') continue;
      if (document.querySelectorAll('[data-mermaid-id="' + id + '"]').length < 2) continue;
      var src = code.textContent;
      block.setAttribute(RETRY_ATTR, '1');
      block.setAttribute('data-mermaid-id', 'mermaid-' + Math.random().toString(36).slice(2, 10) + 'r');
      block.removeAttribute('data-rendered');
      block.classList.remove('prewrap');
      block.classList.add('mermaid-block');
      block.textContent = src;
      // The actions block of this reply was judged "no diagram" while the diagram was a fallback; let it
      // be re-evaluated once core has rendered the repaired diagram.
      var seg = block.closest ? block.closest('[data-msg-idx]') : null;
      if (seg) {
        var pres = seg.querySelectorAll('pre[' + ATTR.state + '="invalid"]');
        for (var k = 0; k < pres.length; k++) pres[k].removeAttribute(ATTR.state);
      }
      n++;
    }
    if (n) { try { render(scope); } catch (_) {} }
    return n;
  }

  function flush() {
    flushRaf = 0;
    var segs = pendingSegs;
    pendingSegs = [];
    if (pendingSet) pendingSet.clear();
    withObserverPaused(function () {
      for (var i = 0; i < segs.length; i++) { try { bindSegment(segs[i]); } catch (_) {} }
    });
    try { repairDuplicateMermaid(transcriptRoot()); } catch (_) {}
  }
  function withObserverPaused(fn) {
    var root = transcriptRoot();
    if (observer) observer.disconnect();
    try { fn(); } finally {
      if (observer && root) observer.observe(root, { childList: true, subtree: true });
    }
  }
  function bindAll() {
    var root = transcriptRoot();
    if (!root) return 0;
    var n = 0;
    withObserverPaused(function () {
      var segs = root.querySelectorAll('.assistant-segment[data-msg-idx]');
      for (var i = 0; i < segs.length; i++) { try { n += bindSegment(segs[i]); } catch (_) {} }
    });
    try { repairDuplicateMermaid(root); } catch (_) {}
    return n;
  }

  // ── click handling: ONE document-level capture-phase click listener ──────
  var lastDown = null;

  function onPointerDown(e) {
    if (!e || !e.isTrusted) return;
    lastDown = {
      x: Number(e.clientX) || 0,
      y: Number(e.clientY) || 0,
      t: Date.now(),
      node: closest(e.target, '[' + ATTR.prompt + ']')
    };
  }
  function resolveBoundNode(e) {
    var direct = closest(e.target, '[' + ATTR.prompt + ']');
    if (direct) return direct;
    // Core's pan/zoom viewport calls setPointerCapture() on pointerdown, which retargets the
    // click to the viewport. Recover the box from the pointerdown target or a hit test.
    if (!closest(e.target, '.mermaid-viewer-viewport, .mermaid-rendered')) return null;
    if (lastDown && lastDown.node && lastDown.node.isConnected && (Date.now() - lastDown.t) < POINTER_MEMORY_MS) return lastDown.node;
    if (typeof document.elementFromPoint === 'function' && isFinite(e.clientX) && isFinite(e.clientY)) {
      var hit = document.elementFromPoint(e.clientX, e.clientY);
      return closest(hit, '[' + ATTR.prompt + ']');
    }
    return null;
  }
  function wasDrag(e) {
    if (!lastDown || !isFinite(e.clientX) || !isFinite(e.clientY)) return false;
    if ((Date.now() - lastDown.t) > POINTER_MEMORY_MS) return false;
    return (Math.abs(e.clientX - lastDown.x) + Math.abs(e.clientY - lastDown.y)) > DRAG_SLOP_PX;
  }
  function onClick(e) {
    if (!e || !e.isTrusted) return;                 // synthetic clicks never send
    if (popover && popover.el.contains(elementOf(e.target))) return;
    if (popover) closePopover();
    if (closest(e.target, '.' + CLS.toolbar)) return;   // toolbar buttons have their own handlers
    var node = resolveBoundNode(e);
    if (!node) return;                              // not ours → core zoom/lightbox keeps working
    if (wasDrag(e)) return;                         // a pan that ended over a box → core decides (no lightbox either)
    e.preventDefault();
    e.stopPropagation();                            // core's viewport.onclick / document click (ui.js:2731) never run
    activateNode(node);
  }
  // After a keyboard confirm, the autorepeat of that same key press is swallowed. Wherever focus
  // lands next, Core binds Enter to "send" (composer) or to "Allow once" (approval card), and neither
  // may act on a press the user aimed at our Send button. The next non-repeat press of that key is a
  // new, deliberate press: it releases the latch and is handled normally. Keys latch independently,
  // so a Space activation can't release the protection of an Enter that is still held.
  var latchedKeys = new Set();
  function onKeydown(e) {
    if (!e || !e.isTrusted) return;
    if (latchedKeys.has(e.key)) {
      if (e.repeat) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      latchedKeys.delete(e.key);
    }
    if (e.key === 'Escape') {
      // Only a preview that owns focus consumes Escape and hands focus back to its box; with focus
      // elsewhere (composer, Core's lightbox) the preview just closes and Core still sees the key.
      if (!popover || e.defaultPrevented) return;
      var ownsFocus = popover.el.contains(document.activeElement);
      closePopover({ restoreFocus: ownsFocus });
      if (ownsFocus) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var node = closest(e.target, '[' + ATTR.prompt + ']');
    if (!node || node !== e.target || document.activeElement !== node) return;
    e.preventDefault();
    e.stopPropagation();
    latchedKeys.add(e.key);   // a held key must not go on to activate the Cancel button that now has focus
    activateNode(node);
  }
  function closeLightboxOf(node) {
    var lb = closest(node, '.img-lightbox');
    if (!lb) return;
    // Decision: a bound box inside the zoomed lightbox copy also sends (the clone keeps our data
    // attributes); the lightbox is closed first so the new turn is visible.
    try { if (typeof _closeImgLightbox === 'function') { _closeImgLightbox(lb); return; } } catch (_) {}
    try { if (lb.parentNode) lb.parentNode.removeChild(lb); } catch (_) {}
  }
  function flashNode(node) {
    try {
      node.classList.add(CLS.flash);
      setTimeout(function () { node.classList.remove(CLS.flash); }, 900);
    } catch (_) {}
  }
  // Core's bubbling document keydown treats Enter as "Allow once" whenever its approval card is
  // visible and focus is not in a text field (static/boot.js, "Enter on approval card"). Enter/Space
  // on our own buttons must never reach it. Native button activation is a default action, so
  // stopping propagation keeps Cancel/Send/toggle/quick-ask working.
  // The same press also latches (see onKeydown): when activation removes or hides the focused
  // control (quick-ask hides the toolbar, Cancel closes the preview), the rest of a held key would
  // otherwise land on <body> or re-activate whatever gets focus next.
  function containActivationKeys(el) {
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.stopPropagation();
        if (e.isTrusted && !e.repeat) latchedKeys.add(e.key);
      }
    });
  }
  var popover = null;
  var popoverSeq = 0;
  function closePopover(opts) {
    if (!popover) return;
    var origin = popover.node;
    clearInterval(popover.timer);
    popover.el.remove();
    popover = null;
    // Cancel / Escape hand focus back to the box that opened the preview, like Core's own dialogs.
    if (opts && opts.restoreFocus && origin && origin.isConnected && typeof origin.focus === 'function') {
      try { origin.focus({ preventScroll: true }); } catch (_) {}
    }
  }
  function activateNode(node) {
    closePopover();
    var mod = sendModule();
    if (!mod) { toast(t('moduleMissing'), 3200, 'error'); return; }
    var prompt = node.getAttribute(ATTR.prompt) || '';
    var bound = { sessionId: node.getAttribute(ATTR.sid) || '', profile: node.getAttribute(ATTR.profile) || 'default' };
    var el = document.createElement('div');
    el.className = 'sigakhwa-click-popover';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('nodeTitle')(prompt, node.getAttribute(ATTR.label)));
    var promptId = 'sigakhwa-click-prompt-' + (++popoverSeq);
    el.setAttribute('aria-describedby', promptId);
    var label = document.createElement('strong');
    label.className = 'sigakhwa-click-popover-title';
    var boxLabel = node.querySelector('.nodeLabel, .label, :scope > text');
    var actionLabel = node.getAttribute(ATTR.label);
    var boxText = boxLabel ? boxLabel.textContent.trim() : (nodeIdFromDomId(node.id) || '');
    // Skip the action label when it only repeats the box text ("③ WebUI — WebUI"). Strip leading
    // non-letters/non-decimal-digits first: circled numerals like ③ are category No, not Nd.
    var showAction = actionLabel && boxText.replace(/^[^\p{L}\p{Nd}]+/u, '').trim() !== actionLabel.trim();
    label.textContent = boxText + (showAction ? ' — ' + actionLabel : '');
    var full = document.createElement('div');
    full.className = 'sigakhwa-click-popover-prompt';
    full.id = promptId;
    full.textContent = prompt;
    var notice = document.createElement('p');
    notice.className = 'sigakhwa-click-popover-notice';
    var actions = document.createElement('div');
    actions.className = 'app-dialog-actions sigakhwa-click-popover-actions';
    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'app-dialog-btn confirm';
    sendBtn.textContent = t('send');
    sendBtn.setAttribute('data-sigakhwa-send', '1');
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'app-dialog-btn';
    cancel.textContent = t('cancel');
    function updateDraft() {
      var msg = document.getElementById('msg');
      sendBtn.disabled = !!(msg && String(msg.value || ''));
      notice.textContent = sendBtn.disabled ? t('draft') : t('notice');
    }
    function confirm(e) {
      if (!e.isTrusted || sendBtn.disabled || !popover || popover.el !== el) return;
      if (e.type === 'keydown' && (document.activeElement !== sendBtn || (e.key !== 'Enter' && e.key !== ' '))) return;
      e.preventDefault();
      e.stopPropagation();
      // A keyboard confirm removes the focused Send button. Hand focus to the composer first (where
      // Core's own send leaves it): on <body>, a held or repeated Enter would reach Core's approval
      // "Allow once" shortcut. If the composer can't take focus, keep the preview open on Cancel and
      // let the send module explain the refusal.
      if (e.type === 'keydown') {
        latchedKeys.add(e.key);
        var composer = document.getElementById('msg');
        if (!composer || composer.disabled) {
          cancel.focus();
          mod.send({ text: prompt, source: 'click-node', bound: bound });   // refused (missing/locked) with its toast
          return;
        }
        try { composer.focus({ preventScroll: true }); } catch (_) { try { composer.focus(); } catch (_e) {} }
      }
      // The box may have been re-rendered or removed since the preview opened (the 100 ms watcher
      // below can lag a fast confirm); never send for a box that is no longer on screen.
      if (!node.isConnected) { closePopover(); return; }
      closePopover();
      closeLightboxOf(node);
      mod.send({ text: prompt, source: 'click-node', bound: bound }).then(function (res) {
        if (res && res.ok) flashNode(node);
      });
    }
    sendBtn.addEventListener('click', confirm);
    sendBtn.addEventListener('keydown', confirm);
    cancel.addEventListener('click', function () { closePopover({ restoreFocus: true }); });
    // Core dialog order: Cancel, then the primary action (Tab from the focused Cancel reaches Send).
    actions.appendChild(cancel);
    actions.appendChild(sendBtn);
    el.appendChild(label);
    el.appendChild(full);
    el.appendChild(notice);
    el.appendChild(actions);
    containActivationKeys(el);
    (document.body || document.documentElement).appendChild(el);
    popover = { el: el, node: node, timer: setInterval(function () {
      var current = mod.currentTarget();
      if (!node.isConnected || !current || current.sessionId !== bound.sessionId || current.profile !== bound.profile) closePopover();
      else updateDraft();
    }, 100) };
    updateDraft();
    var rect = node.getBoundingClientRect();
    var box = el.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    el.style.left = Math.round(Math.max(8, Math.min(rect.right + 8, vw - (box.width || Math.min(340, vw - 16)) - 8))) + 'px';
    el.style.top = Math.round(Math.max(8, Math.min(rect.top, vh - (box.height || 240) - 8))) + 'px';
    cancel.focus();
  }

  // Selection quick-ask toolbar.
  var tb = { el: null, text: '', bound: null, raf: 0, interactingUntil: 0 };

  function ensureToolbar() {
    if (tb.el && tb.el.isConnected) return tb.el;
    var el = document.createElement('div');
    el.className = CLS.toolbar;
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', t('toolbarLabel'));
    el.setAttribute('data-sigakhwa-toolbar', '1');
    containActivationKeys(el);
    // Keep the selection alive while the pointer lands on a button (mousedown would collapse it).
    // Cancelling pointerdown/mousedown does NOT suppress the following `click`. `touchstart` is
    // deliberately NOT cancelled: per the Touch Events spec a cancelled touchstart suppresses the
    // compatibility mousedown/mouseup/click for that tap, so the buttons would never fire on a phone
    // (pointer events already cover touch input).
    var keep = function (ev) { ev.preventDefault(); tb.interactingUntil = Date.now() + 600; };
    el.addEventListener('pointerdown', keep);
    el.addEventListener('mousedown', keep);
    for (var i = 0; i < TEMPLATES.length; i++) {
      (function (tpl) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = t(tpl.key + 'Label');
        btn.setAttribute('data-sigakhwa-template', tpl.key);
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (!ev.isTrusted) return;                // never send without a real gesture
          onTemplateClick(tpl.key);
        });
        el.appendChild(btn);
      })(TEMPLATES[i]);
    }
    (document.body || document.documentElement).appendChild(el);
    tb.el = el;
    return el;
  }
  function rowOf(node) {
    return closest(node, SEL_ROW);
  }
  function selectionInfo() {
    if (!window.getSelection) return null;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var root = transcriptRoot();
    if (!root) return null;
    var range = sel.getRangeAt(0);
    var startRow = rowOf(range.startContainer);
    var endRow = rowOf(range.endContainer);
    if (!startRow || startRow !== endRow || !root.contains(startRow)) return null;   // fully inside ONE row
    if (!startRow.classList.contains('assistant-segment')) return null;             // assistant rows only
    if (isLive(startRow)) return null;                                              // settled only
    if (closest(range.startContainer, '.msg-edit-area, [data-sigakhwa-caption], .' + CLS.toolbar)) return null;
    var text = normalizeSelection(sel.toString());
    if (!text) return null;
    var rect = null;
    try { rect = range.getBoundingClientRect(); } catch (_) { rect = null; }
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text: text, rect: rect, row: startRow };
  }
  // Core's selection Reply/Refine group (static/style.css .selected-text-action-group): 40 px tall
  // under a fine pointer, 52 px under a coarse one. Measure it when visible; otherwise reserve room.
  var CORE_GROUP_RESERVE = 60;
  function coreSelectionGroupRect() {
    try {
      var g = document.querySelector('.selected-text-action-group.visible');
      if (!g) return null;
      var r = g.getBoundingClientRect();
      return (r && r.height > 0) ? r : null;
    } catch (_) { return null; }
  }
  function positionToolbar(el, rect) {
    var gap = 8;
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var box = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    var w = box.width || 260;
    var h = box.height || 40;
    var left = rect.left + (rect.width / 2) - (w / 2);
    left = Math.min(Math.max(gap, left), Math.max(gap, vw - w - gap));
    // Below the selection (core's own reply/refine group sits above it); flip above when it would
    // cross the composer (or the viewport bottom), clearing Core's group by its measured rect (it is
    // taller under a coarse pointer). Selecting the last line of the latest reply is the common case,
    // and the composer must stay tappable.
    var limit = vh;
    try {
      var composer = document.getElementById('composerWrap');
      var cr = composer && composer.getBoundingClientRect ? composer.getBoundingClientRect() : null;
      if (cr && cr.height > 0 && cr.top > 0 && cr.top < limit) limit = cr.top;
    } catch (_) {}
    var top = rect.bottom + gap;
    if (top + h > limit - gap) {
      var core = coreSelectionGroupRect();
      top = core ? Math.min(rect.top, core.top) - h - gap : rect.top - h - gap - CORE_GROUP_RESERVE;
      top = Math.max(gap, Math.min(top, limit - h - gap));   // never below the composer's top edge
    }
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }
  function showToolbar(info) {
    var el = ensureToolbar();
    el.setAttribute('aria-label', t('toolbarLabel'));
    var buttons = el.querySelectorAll('[data-sigakhwa-template]');
    for (var i = 0; i < buttons.length; i++) buttons[i].textContent = t(buttons[i].getAttribute('data-sigakhwa-template') + 'Label');
    tb.text = info.text;
    tb.bound = captureTarget(info.row);         // captured when the toolbar is shown
    if (!tb.bound) { hideToolbar(); return; }
    el.classList.add(CLS.toolbarVisible);
    positionToolbar(el, info.rect);
  }
  function hideToolbar() {
    if (tb.el) tb.el.classList.remove(CLS.toolbarVisible);
    tb.text = '';
    tb.bound = null;
  }
  function updateToolbar() {
    tb.raf = 0;
    if (Date.now() < tb.interactingUntil) return;   // a button press is in progress
    var info = selectionInfo();
    if (!info) { hideToolbar(); return; }
    showToolbar(info);
  }
  function scheduleToolbarUpdate() {
    if (tb.raf) return;
    var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
    tb.raf = raf(updateToolbar);
  }
  function onDocumentPointerDown(e) {
    if (e.isTrusted && popover && !popover.el.contains(elementOf(e.target))) closePopover();
    if (tb.el && closest(e.target, '.' + CLS.toolbar)) return;
    hideToolbar();
  }
  function onTemplateClick(key) {
    var text = renderTemplate(key, tb.text);
    var bound = tb.bound;
    var mod = sendModule();
    if (!text || !bound) { hideToolbar(); return Promise.resolve({ ok: false, reason: 'empty' }); }
    if (!mod) { toast(t('moduleMissing'), 3200, 'error'); return Promise.resolve({ ok: false, reason: 'core_missing' }); }
    return mod.send({ text: text, source: 'selection', bound: bound }).then(function (res) {
      if (res && res.ok) {
        try { var sel = window.getSelection && window.getSelection(); if (sel && sel.removeAllRanges) sel.removeAllRanges(); } catch (_) {}
        hideToolbar();
      }
      // on refusal the selection + toolbar stay so the user can retry after the toast
      return res;
    });
  }

  // ── install ──────────────────────────────────────────────────────────────
  var installed = false;
  function install(attempt) {
    if (installed) return true;
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return false;
    var root = transcriptRoot();
    if (!root) {
      var n = attempt || 0;
      if (n < 80) setTimeout(function () { install(n + 1); }, 150);
      return false;
    }
    installed = true;
    observer = new MutationObserver(onMutations);
    observer.observe(root, { childList: true, subtree: true });
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('selectionchange', scheduleToolbarUpdate);
    document.addEventListener('mouseup', scheduleToolbarUpdate);
    document.addEventListener('touchend', scheduleToolbarUpdate);
    document.addEventListener('keyup', function (e) { if (e && /Arrow|Shift|Home|End/.test(String(e.key || ''))) scheduleToolbarUpdate(); });
    document.addEventListener('scroll', hideToolbar, true);
    window.addEventListener('resize', function () { hideToolbar(); closePopover(); });
    bindAll();
    return true;
  }

  window.SigakhwaClick = Object.freeze({
    id: EXT_ID,
    version: VERSION,
    parseActions: parseActions,
    nodeIdFromDomId: nodeIdFromDomId,
    renderTemplate: renderTemplate,
    normalizeSelection: normalizeSelection,
    templates: Object.freeze(TEMPLATES.map(function (tpl) { return Object.freeze({ key: tpl.key, label: t(tpl.key + 'Label') }); })),
    bindSegment: bindSegment,
    bindAll: bindAll,
    positionToolbar: positionToolbar,
    install: install,
    limits: Object.freeze({ MAX_NODES: MAX_NODES, MAX_PROMPT: MAX_PROMPT, MAX_LABEL: MAX_LABEL, MAX_SELECTION: MAX_SELECTION, MAX_SEND: MAX_SEND })
  });

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { install(0); }, { once: true });
    else install(0);
  }
})();
