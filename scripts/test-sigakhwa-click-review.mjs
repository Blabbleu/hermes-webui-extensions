import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';
import utils from 'jsdom/lib/jsdom/living/generated/utils.js';

const base = new URL('../extensions/sigakhwa-click/', import.meta.url);
const sendSource = readFileSync(new URL('assets/shared/hermes-viz-send.js', base), 'utf8');
const clickSource = readFileSync(new URL('assets/sigakhwa-click.js', base), 'utf8');
const prompt = 'Review <img src=x onerror=alert(1)>\nSecond line';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function harness(lang = 'en') {
  const dom = new JSDOM('<!doctype html><html><body><textarea id="msg"></textarea><button id="btnSend"></button><div id="msgInner"><div class="assistant-turn" data-session-id="s1"><div class="assistant-segment" data-msg-idx="0"><div class="mermaid-block"><svg><g class="node" id="flowchart-A-0"><rect width="80" height="40"/><text class="label">Box A</text></g></svg></div><div class="pre-header">sigakhwa-actions</div><pre><code class="language-sigakhwa-actions"></code></pre><p id="selected">Some selected text</p></div></div></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.document.querySelector('.mermaid-block').classList.add('mermaid-rendered');
  w.document.documentElement.lang = lang;
  w.S = { session: { session_id: 's1' }, activeProfile: 'p1', busy: false, pendingFiles: [] };
  const calls = [];
  const toasts = [];
  w.showToast = text => toasts.push(text);
  w.send = () => { calls.push(w.document.getElementById('msg').value); w.document.getElementById('msg').value = ''; return Promise.resolve(); };
  w.document.querySelector('code').textContent = JSON.stringify({ v: 1, nodes: { A: { prompt, label: 'Details' } } });
  w.eval(sendSource);
  w.eval(clickSource);
  w.SigakhwaClick.install();
  w.SigakhwaClick.bindAll();
  return { dom, w, calls, toasts, node: w.document.querySelector('g.node'), msg: w.document.getElementById('msg'), api: w.SigakhwaClick, send: w.HermesVizSend };
}
// jsdom dispatch resets trust; dispatch via its implementation as existing private tests do.
function gesture(h, target, type = 'click', init = {}, trusted = true) {
  const ev = type === 'keydown' ? new h.w.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }) : new h.w.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  if (trusted) {
    const impl = utils.implForWrapper(ev);
    impl.isTrusted = true;
    utils.implForWrapper(target)._dispatch(impl);
  } else target.dispatchEvent(ev);
}
const pop = h => h.w.document.querySelector('.sigakhwa-click-popover');
const sendButton = h => pop(h).querySelector('[data-sigakhwa-send]');

test('schema: structural failures, bounded prompts, slash and known-node refusal', () => {
  const h = harness();
  try {
    const parse = h.api.parseActions;
    assert.equal(parse('{').ok, false);
    for (const data of [{ v: 2, nodes: {} }, { v: 1, nodes: [] }, { v: 1, diagram: -1, nodes: { A: { prompt: 'x' } } }]) assert.equal(parse(JSON.stringify(data)).ok, false);
    for (const p of ['/stop', 'x'.repeat(501), '\u0001', '']) assert.equal(parse(JSON.stringify({ v: 1, nodes: { A: { prompt: p } } })).ok, false);
    assert.equal(parse(JSON.stringify({ v: 1, nodes: { B: { prompt: 'x' } } }), ['A']).ok, false);
    const good = parse(JSON.stringify({ v: 1, nodes: { A: { prompt: 'x', label: 'L', url: 'javascript:x' }, B: { prompt: '/stop' } } }), ['A', 'B']);
    assert.equal(good.ok, true);
    assert.equal(good.nodes.length, 1);
    assert.equal(good.nodes[0].prompt, 'x');
    assert.equal(good.dropped, 1);
  } finally { h.dom.window.close(); }
});

test('selection: clip, quote, linear whitespace normalization under 50ms', () => {
  const h = harness('ko');
  try {
    assert.equal(h.api.normalizeSelection('a \t\r\n\n\nb'), 'a\n\nb');
    for (const key of ['explain', 'evidence', 'visualize', 'compare']) {
      const text = h.api.renderTemplate(key, 'x'.repeat(8000));
      assert.ok(text.length <= 2000);
      assert.ok(text.includes('…'));
      assert.ok(text.includes('> '));
      assert.ok(h.api.renderTemplate(key, 'a\n'.repeat(3000)).length <= 2000);
    }
    for (const input of [' '.repeat(80000), ' \t'.repeat(40000)]) {
      const start = performance.now();
      assert.equal(h.api.renderTemplate('explain', input), null);
      assert.ok(performance.now() - start < 50);
    }
  } finally { h.dom.window.close(); }
});

test('send: stale session/profile, draft, local busy and duplicate guards', async () => {
  const h = harness();
  try {
    const request = { text: 'Question', source: 'selection', bound: { sessionId: 's1', profile: 'p1' } };
    assert.equal((await h.send.send({ ...request, bound: { sessionId: 's2', profile: 'p1' } })).reason, 'stale_session');
    assert.equal((await h.send.send({ ...request, bound: { sessionId: 's1', profile: 'p2' } })).reason, 'stale_profile');
    h.msg.value = ' \n';
    assert.equal((await h.send.send(request)).reason, 'draft_present');
    assert.equal(h.msg.value, ' \n');
    assert.equal(h.calls.length, 0);
    h.msg.value = '';
    h.w.S.busy = true;
    assert.equal((await h.send.send(request)).reason, 'busy');
    h.w.S.busy = false;
    assert.equal((await h.send.send(request)).ok, true);
    assert.equal((await h.send.send(request)).reason, 'duplicate');
    assert.equal(h.calls.length, 1);
  } finally { h.dom.window.close(); }
});

test('popover: tap previews text only; trusted Send sends exactly once', async () => {
  const h = harness();
  try {
    gesture(h, h.node);
    assert.equal(h.calls.length, 0);
    assert.equal(pop(h).querySelector('.sigakhwa-click-popover-prompt').textContent, prompt);
    assert.equal(pop(h).querySelector('img'), null);
    assert.ok(pop(h).textContent.includes('Details'));
    assert.ok(pop(h).querySelector('strong').textContent.includes('Box A'));
    assert.equal(sendButton(h).textContent, 'Send');
    const btn = sendButton(h);
    gesture(h, btn, 'click', {}, false);
    assert.equal(h.calls.length, 0);
    gesture(h, btn);
    gesture(h, btn);
    await wait(0);
    assert.deepEqual(h.calls, [prompt]);
    assert.equal(pop(h), null);
  } finally { h.dom.window.close(); }
});

test('popover: cancel, Escape, outside click, one popover, synthetic node rejection', () => {
  const h = harness();
  try {
    gesture(h, h.node, 'click', {}, false);
    assert.equal(pop(h), null);
    gesture(h, h.node);
    gesture(h, pop(h).querySelector('button:not([data-sigakhwa-send])'));
    assert.equal(pop(h), null);
    gesture(h, h.node);
    gesture(h, h.w.document.body, 'keydown', { key: 'Escape' });
    assert.equal(pop(h), null);
    gesture(h, h.node);
    gesture(h, h.node);
    assert.equal(h.w.document.querySelectorAll('.sigakhwa-click-popover').length, 1);
    gesture(h, h.w.document.body);
    assert.equal(pop(h), null);
    assert.equal(h.calls.length, 0);
  } finally { h.dom.window.close(); }
});

test('popover: draft disables Send and send-time guards catch later draft/busy/session/profile', async () => {
  for (const reason of ['draft', 'busy', 'session', 'profile']) {
    const h = harness();
    try {
      h.msg.value = 'existing draft';
      gesture(h, h.node);
      assert.equal(sendButton(h).disabled, true);
      assert.ok(pop(h).textContent.includes('Send or clear your draft first'));
      gesture(h, sendButton(h));
      assert.equal(h.calls.length, 0);
      h.msg.value = '';
      gesture(h, h.node);
      if (reason === 'draft') h.msg.value = 'new draft';
      if (reason === 'busy') h.w.S.busy = true;
      if (reason === 'session') h.w.S.session.session_id = 's2';
      if (reason === 'profile') h.w.S.activeProfile = 'p2';
      gesture(h, sendButton(h));
      await wait(0);
      assert.equal(h.calls.length, 0);
      if (reason === 'draft') assert.equal(h.msg.value, 'new draft');
    } finally { h.dom.window.close(); }
  }
});

test('popover: focused Enter/Space, session/profile changes close, narrow viewport clamping', async () => {
  for (const key of ['Enter', ' ']) {
    const h = harness();
    try {
      Object.defineProperty(h.w, 'innerWidth', { value: 390 });
      h.node.getBoundingClientRect = () => ({ right: 389, top: 900 });
      h.node.focus();
      gesture(h, h.node, 'keydown', { key });
      assert.ok(pop(h));
      assert.ok(parseFloat(pop(h).style.left) >= 8 && parseFloat(pop(h).style.left) <= 42);
      const btn = sendButton(h);
      gesture(h, btn, 'keydown', { key });
      assert.equal(h.calls.length, 0);
      btn.focus();
      gesture(h, btn, 'keydown', { key });
      await wait(0);
      assert.equal(h.calls.length, 1);
    } finally { h.dom.window.close(); }
  }
  for (const change of ['session', 'profile']) {
    const h = harness();
    try {
      gesture(h, h.node);
      if (change === 'session') h.w.S.session.session_id = 's2';
      else h.w.S.activeProfile = 'p2';
      await wait(130);
      assert.equal(pop(h), null);
      assert.equal(h.calls.length, 0);
    } finally { h.dom.window.close(); }
  }
});

test('language: Korean unchanged, English default, next popover/template/toast uses new locale', async () => {
  const h = harness('ko-KR');
  try {
    assert.equal(h.api.renderTemplate('explain', '선택'), '다음 부분을 더 쉽게 설명해줘:\n\n> 선택');
    assert.equal(h.api.renderTemplate('evidence', '선택'), '다음 내용의 근거를 확인해줘. 출처나 근거를 댈 수 없으면 그렇게 말해줘:\n\n> 선택');
    assert.equal(h.api.renderTemplate('visualize', '선택'), '시각화\n\n> 선택');
    assert.equal(h.api.renderTemplate('compare', '선택'), '다음 내용에 대한 대안 2~3개를 비교해줘:\n\n> 선택');
    gesture(h, h.node);
    assert.equal(sendButton(h).textContent, '보내기');
    h.w.document.documentElement.lang = 'en';
    gesture(h, h.node);
    assert.equal(sendButton(h).textContent, 'Send');
    assert.equal(h.api.renderTemplate('explain', 'text'), 'Explain the following more simply:\n\n> text');
    h.msg.value = 'draft';
    await h.send.send({ text: 'x', bound: { sessionId: 's1', profile: 'p1' } });
    assert.equal(h.toasts.at(-1), 'Send or clear your draft first');
    h.w.document.documentElement.lang = 'ko';
    await h.send.send({ text: 'x', bound: { sessionId: 's1', profile: 'p1' } });
    assert.equal(h.toasts.at(-1), '입력창의 초안을 먼저 보내거나 지워 주세요');
  } finally { h.dom.window.close(); }
});

test('metadata declares both Core writes consistently; comments and README reflect safeguards', () => {
  const entry = JSON.parse(readFileSync(new URL('extension.json', base), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8')).extensions[0];
  assert.deepEqual(entry.permissions, manifest.permissions);
  assert.deepEqual(entry.permissions.webui_api.write, ['/api/chat/start', '/api/session/draft']);
  assert.doesNotMatch(sendSource + clickSource, /docs\/(?:INTERFACES|CORE-FACTS|CONSTRAINTS)\.md/);
  const readme = readFileSync(new URL('README.md', base), 'utf8');
  assert.match(readme, /exp-v0\.52\.460/);
  assert.match(readme, /local state/);
  assert.doesNotMatch(readme, /restored after the send|sent immediately|not queued or steered/);
});

test('quick-asks: one trusted click, synthetic refusal, draft refusal, localized toolbar on next render', async () => {
  for (const key of ['explain', 'evidence', 'visualize', 'compare']) {
    const h = harness('ko');
    try {
      const range = h.w.document.createRange();
      range.selectNodeContents(h.w.document.getElementById('selected'));
      range.getBoundingClientRect = () => ({ left: 10, top: 20, bottom: 40, width: 100, height: 20 });
      const sel = h.w.getSelection();
      sel.addRange(range);
      // jsdom may clone the range returned by getRangeAt.
      sel.getRangeAt(0).getBoundingClientRect = range.getBoundingClientRect;
      h.w.document.dispatchEvent(new h.w.Event('selectionchange'));
      await wait(30);
      const toolbar = h.w.document.querySelector('[data-sigakhwa-toolbar]');
      assert.ok(toolbar.classList.contains('is-visible'));
      const btn = toolbar.querySelector('[data-sigakhwa-template="' + key + '"]');
      gesture(h, btn, 'click', {}, false);
      assert.equal(h.calls.length, 0);
      h.msg.value = 'draft';
      gesture(h, btn);
      await wait(0);
      assert.equal(h.calls.length, 0);
      assert.equal(h.toasts.at(-1), '입력창의 초안을 먼저 보내거나 지워 주세요');
      h.msg.value = '';
      h.w.document.documentElement.lang = 'en';
      h.w.document.dispatchEvent(new h.w.Event('selectionchange'));
      await wait(30);
      const expectedLabels = { explain: 'Explain simply', evidence: 'Check evidence', visualize: 'Visualize', compare: 'Compare alternatives' };
      assert.equal(btn.textContent, expectedLabels[key]);
      gesture(h, btn);
      await wait(0);
      assert.deepEqual(h.calls, [h.api.renderTemplate(key, 'Some selected text')]);
      assert.equal(pop(h), null);
    } finally { h.dom.window.close(); }
  }
});

test('send completion never restores or persists a draft into another conversation', async () => {
  const h = harness();
  try {
    let resolve;
    h.w.send = () => { h.msg.value = ''; return new Promise(r => { resolve = r; }); };
    let inputs = 0;
    h.msg.addEventListener('input', () => { inputs++; });
    const result = h.send.send({ text: 'Question', bound: { sessionId: 's1', profile: 'p1' } });
    h.w.S.session.session_id = 's2';
    h.msg.value = 'Draft in conversation B';
    resolve();
    assert.equal((await result).ok, true);
    assert.equal(h.msg.value, 'Draft in conversation B');
    assert.equal(inputs, 1);
  } finally { h.dom.window.close(); }
});

test('maintainer review: confirm refuses a box removed before the watcher noticed', async () => {
  const h = harness();
  try {
    gesture(h, h.node);
    const btn = sendButton(h);
    h.node.remove();                           // re-render/removal inside the 100 ms watcher window
    gesture(h, btn);
    await wait(0);
    assert.equal(h.calls.length, 0, 'a disconnected box must never send');
    assert.equal(pop(h), null, 'the stale preview closes');
  } finally { h.dom.window.close(); }
});

test('maintainer review: node lookups are prototype-free (constructor / __proto__ / toString)', () => {
  const h = harness();
  try {
    const parse = h.api.parseActions;
    for (const evil of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const res = parse(JSON.stringify({ v: 1, nodes: { [evil]: { prompt: 'x' }, A: { prompt: 'y' } } }), ['A']);
      assert.equal(res.ok, true, evil);
      assert.deepEqual(Array.from(res.nodes, n => n.id), ['A'], evil + ' must not pass known-node membership');
    }
    // A real diagram node whose Mermaid id is "constructor" binds instead of being skipped or throwing.
    const svg = h.w.document.querySelector('svg');
    const g = h.w.document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'node');
    g.setAttribute('id', 'flowchart-constructor-1');
    g.innerHTML = '<rect width="80" height="40"/><text class="label">Ctor</text>';
    svg.appendChild(g);
    h.w.document.querySelector('code').textContent = JSON.stringify({ v: 1, nodes: { constructor: { prompt: 'ctor prompt' }, A: { prompt: 'a prompt' } } });
    h.w.document.querySelector('pre').removeAttribute('data-sigakhwa-state');
    h.w.document.querySelectorAll('[data-sigakhwa-caption]').forEach(n => n.remove());
    h.api.bindAll();
    assert.equal(g.getAttribute('data-sigakhwa-prompt'), 'ctor prompt');
  } finally { h.dom.window.close(); }
});

test('maintainer review: Core dialog buttons, Cancel first, focus returns to the box', () => {
  const h = harness();
  try {
    h.node.setAttribute('tabindex', '0');
    gesture(h, h.node);
    const buttons = [...pop(h).querySelectorAll('button')];
    assert.deepEqual(buttons.map(b => b.textContent), ['Cancel', 'Send']);
    assert.ok(buttons[0].classList.contains('app-dialog-btn'));
    assert.ok(buttons[1].classList.contains('app-dialog-btn') && buttons[1].classList.contains('confirm'));
    const desc = pop(h).getAttribute('aria-describedby');
    assert.ok(desc && h.w.document.getElementById(desc).textContent === prompt, 'dialog is described by the prompt');
    gesture(h, buttons[0]);
    assert.equal(pop(h), null);
    assert.equal(h.w.document.activeElement, h.node, 'Cancel returns focus to the box');
    gesture(h, h.node);
    gesture(h, h.w.document.body, 'keydown', { key: 'Escape' });
    assert.equal(h.w.document.activeElement, h.node, 'Escape returns focus to the box');
  } finally { h.dom.window.close(); }
});

test('maintainer review: popover stacks above Core lightbox; coarse targets are 44px', () => {
  const css = readFileSync(new URL('assets/sigakhwa-click.css', base), 'utf8');
  const block = css.slice(css.indexOf('.sigakhwa-click-popover {'));
  const z = Number((/z-index:\s*(\d+)/.exec(block) || [])[1]);
  assert.ok(z > 9999, 'popover z-index ' + z + ' must exceed Core .img-lightbox (9999)');
  assert.match(css, /@media \(pointer: coarse\)[^}]*\.sigakhwa-click-popover \.app-dialog-btn[^}]*min-height: 44px/);
});

test('maintainer review: flipped toolbar clears Core selection group by its measured rect', () => {
  const h = harness();
  try {
    const d = h.w.document;
    const core = d.createElement('div');
    core.className = 'selected-text-action-group visible';
    d.body.appendChild(core);
    // Selection near the bottom of an 800px viewport forces the flip; Core's group sits 52px above it.
    Object.defineProperty(h.w, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(h.w, 'innerWidth', { value: 390, configurable: true });
    core.getBoundingClientRect = () => ({ top: 700, bottom: 752, left: 100, right: 220, width: 120, height: 52 });
    const sel = { top: 760, bottom: 780, left: 50, right: 250, width: 200, height: 20 };
    const tb = d.createElement('div');
    tb.getBoundingClientRect = () => ({ width: 260, height: 96 });
    h.api.positionToolbar(tb, sel);
    const top = parseInt(tb.style.top, 10);
    assert.ok(top + 96 <= 700 - 8 + 0.5, 'toolbar bottom ' + (top + 96) + ' must clear Core group top 700');
    // Without a visible Core group the flip still reserves room for the 52px coarse-pointer group.
    core.remove();
    h.api.positionToolbar(tb, sel);
    assert.ok(parseInt(tb.style.top, 10) + 96 <= 760 - 52 - 8, 'fallback reserve clears a 52px group');
  } finally { h.dom.window.close(); }
});

test('maintainer review: Escape restores focus only when the preview owns it, and only then consumes the key', () => {
  const h = harness();
  try {
    const seen = [];
    h.w.document.addEventListener('keydown', e => seen.push(e.key));   // stands in for Core's own Escape handling
    h.node.setAttribute('tabindex', '0');
    // Focus moved to the composer while the preview is open: close it, keep focus, let Core see Escape.
    gesture(h, h.node);
    h.msg.focus();
    gesture(h, h.msg, 'keydown', { key: 'Escape' });
    assert.equal(pop(h), null);
    assert.equal(h.w.document.activeElement, h.msg, 'Escape must not steal focus from the composer');
    assert.deepEqual(seen.slice(), ['Escape'], 'an Escape the preview does not own still reaches Core');
    // Focus inside the preview: close, return focus to the box, consume the key.
    seen.length = 0;
    gesture(h, h.node);
    assert.ok(pop(h).contains(h.w.document.activeElement));
    gesture(h, h.w.document.activeElement, 'keydown', { key: 'Escape' });
    assert.equal(pop(h), null);
    assert.equal(h.w.document.activeElement, h.node);
    assert.equal(seen.length, 0, 'an Escape the preview owns is consumed');
  } finally { h.dom.window.close(); }
});

test('maintainer review: title skips an action label that repeats the box text; badge beats Mermaid id rules', () => {
  const h = harness();
  try {
    h.node.setAttribute('data-sigakhwa-label', 'Box A');
    gesture(h, h.node);
    assert.equal(pop(h).querySelector('.sigakhwa-click-popover-title').textContent, 'Box A');
    gesture(h, pop(h).querySelector('button:not([data-sigakhwa-send])'));
    h.node.setAttribute('data-sigakhwa-label', 'Details');
    gesture(h, h.node);
    assert.equal(pop(h).querySelector('.sigakhwa-click-popover-title').textContent, 'Box A — Details');
    gesture(h, pop(h).querySelector('button:not([data-sigakhwa-send])'));     // stop the preview watcher
  } finally { h.dom.window.close(); }
  const css = readFileSync(new URL('assets/sigakhwa-click.css', base), 'utf8');
  assert.match(css, /\.sigakhwa-click-badge circle \{[^}]*fill: var\(--accent, #b8860b\) !important/);
  assert.match(css, /\.sigakhwa-click-badge text \{[^}]*fill: var\(--bg, #ffffff\) !important/, 'badge glyph uses --bg so it stays legible on the dark theme accent');
});

test('maintainer review: toolbar never covers the composer; circled-number boxes dedupe the title', async () => {
  const h = harness();
  try {
    const d = h.w.document;
    Object.defineProperty(h.w, 'innerHeight', { value: 844, configurable: true });
    Object.defineProperty(h.w, 'innerWidth', { value: 390, configurable: true });
    const composer = d.createElement('div');
    composer.id = 'composerWrap';
    composer.getBoundingClientRect = () => ({ top: 700, bottom: 844, left: 0, right: 390, width: 390, height: 144 });
    d.body.appendChild(composer);
    const tb = d.createElement('div');
    tb.getBoundingClientRect = () => ({ width: 374, height: 96 });
    // Last visible line of the latest reply: below-slot would end at 690 + 8 + 96 = 794 > composer top 700.
    h.api.positionToolbar(tb, { top: 670, bottom: 690, left: 20, right: 300, width: 280, height: 20 });
    const top = parseInt(tb.style.top, 10);
    assert.ok(top + 96 <= 700, 'toolbar bottom ' + (top + 96) + ' must stay above the composer (700)');
    // Plenty of room above the composer: stays below the selection.
    h.api.positionToolbar(tb, { top: 300, bottom: 320, left: 20, right: 300, width: 280, height: 20 });
    assert.equal(parseInt(tb.style.top, 10), 328);
  } finally { h.dom.window.close(); }
  const h2 = harness();
  try {
    h2.node.querySelector('text').textContent = '③ WebUI';
    h2.node.setAttribute('data-sigakhwa-label', 'WebUI');
    await wait(60);                                   // let the transcript observer settle the text edit
    gesture(h2, h2.node);
    assert.equal(pop(h2).querySelector('.sigakhwa-click-popover-title').textContent, '③ WebUI');
    gesture(h2, pop(h2).querySelector('button:not([data-sigakhwa-send])'));   // stop the preview watcher
    await wait(60);
  } finally { h2.dom.window.close(); }
});

test('maintainer review: Enter/Space on our buttons never reach Core\'s approval shortcut', async () => {
  const h = harness();
  try {
    const d = h.w.document;
    const coreSaw = [];
    // Stands in for Core's bubbling document keydown ("Enter on approval card = Allow once").
    d.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') coreSaw.push(e.target.textContent || e.target.tagName); });
    gesture(h, h.node);
    const cancel = pop(h).querySelector('button:not([data-sigakhwa-send])');
    gesture(h, cancel, 'keydown', { key: 'Enter' });
    gesture(h, cancel, 'keydown', { key: ' ' });
    h.msg.value = 'draft';                         // disabled Send: confirm() returns early, key must still be contained
    await wait(150);
    gesture(h, sendButton(h), 'keydown', { key: 'Enter' });
    h.msg.value = '';
    gesture(h, cancel);
    const toggle = d.querySelector('.sigakhwa-click-caption-toggle');
    assert.ok(toggle, 'caption toggle rendered');
    gesture(h, toggle, 'keydown', { key: 'Enter' });
    // Selection toolbar buttons.
    const range = d.createRange();
    range.selectNodeContents(d.getElementById('selected'));
    range.getBoundingClientRect = () => ({ left: 10, top: 20, bottom: 40, width: 100, height: 20 });
    const sel = h.w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    sel.getRangeAt(0).getBoundingClientRect = range.getBoundingClientRect;   // jsdom may clone the range
    d.dispatchEvent(new h.w.Event('selectionchange'));
    await wait(60);
    const tbButton = d.querySelector('[data-sigakhwa-toolbar].is-visible button');
    assert.ok(tbButton, 'selection toolbar is showing');
    gesture(h, tbButton, 'keydown', { key: 'Enter' });
    assert.deepEqual(coreSaw.slice(), [], 'Core saw activation keys: ' + coreSaw.join(', '));
    assert.equal(h.calls.length, 0);
  } finally { h.dom.window.close(); }
});
