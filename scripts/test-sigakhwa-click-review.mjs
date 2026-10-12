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
    assert.equal(pop(h).querySelector('pre').textContent, prompt);
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
    gesture(h, pop(h).querySelectorAll('button')[1]);
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
