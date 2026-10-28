import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

const assets = ['../extension/assets/', '../extensions/flightdeck/assets/']
  .map(p => new URL(p, import.meta.url)).find(p => existsSync(fileURLToPath(new URL('flightdeck.js', p))));
if (!assets) throw new Error('Flightdeck assets not found in standalone or gallery layout');
const core = readFileSync(new URL('fd-core.js', assets), 'utf8');
const ui = readFileSync(new URL('flightdeck.js', assets), 'utf8');
const copy = v => structuredClone(v);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = body => ({ ok: true, json: async () => body });

async function harness(t, { sid = 'parent', stream = null, compact = false, initial = {}, fetcher } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="layout"><div class="rightpanel" data-active-tab="browse"><div class="workspace-panel-tabs"><button class="workspace-panel-tab active" aria-selected="true">Browse</button></div><div id="previewArea"></div></div></div><div><div id="composerWrap"></div></div></body></html>', { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  await new Promise(resolve => w.document.readyState === 'loading' ? w.document.addEventListener('DOMContentLoaded', resolve, { once: true }) : resolve());
  let now = 1700000000000, next = 1;
  const jobs = new Map(), NativeDate = w.Date;
  w.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  const add = (fn, delay, interval = 0) => { const id = next++; jobs.set(id, { fn, at: now + Number(delay || 0), interval }); return id; };
  w.setTimeout = (fn, ms) => add(fn, ms); w.clearTimeout = id => jobs.delete(id);
  w.setInterval = (fn, ms) => add(fn, ms, ms); w.clearInterval = id => jobs.delete(id);
  w.requestAnimationFrame = fn => add(() => fn(now), 1); w.cancelAnimationFrame = id => jobs.delete(id);
  async function tick(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, job] = due; now = job.at;
      if (job.interval) job.at += job.interval; else jobs.delete(id);
      job.fn(); await flush();
    }
    now = end; await flush();
  }
  const values = copy(initial), events = {}, sources = [], requests = [];
  const storage = { get: (k, fallback) => k in values ? copy(values[k]) : fallback,
    getAll: () => copy(values), set: (k, v) => { values[k] = copy(v); return true; }, remove: k => { delete values[k]; return true; } };
  w.hermesExt = { register: () => ({ storage, settings: { get: () => undefined }, events: { on: (name, cb) => { events[name] = cb; } } }) };
  w.S = { session: sid ? { session_id: sid, model: 'example-model' } : null, activeStreamId: stream };
  w._isCompactWorkspaceViewport = () => compact;
  let opened = 0;
  w.openWorkspacePanel = () => { opened++; w.document.querySelector('.rightpanel').classList.add('mobile-open'); w.document.querySelector('.layout').classList.remove('workspace-panel-collapsed'); };
  class Source {
    constructor(url) { this.url = url; this.readyState = 1; this.listeners = {}; this.closed = false; sources.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.readyState = 2; this.closed = true; }
    emit(name, data = {}, seq = 1) { this.listeners[name]?.({ data: JSON.stringify(data), lastEventId: `${new URL(this.url).searchParams.get('stream_id')}:${seq}` }); }
    failClosed() { this.readyState = 2; this.onerror?.(); }
  }
  w.EventSource = Source;
  w.fetch = (url, options) => { requests.push({ url, options }); return fetcher ? fetcher(url, options) : Promise.resolve(response({ sessions: [] })); };
  Object.defineProperty(w.document, 'hidden', { value: false, configurable: true });
  w.eval(core); w.eval(ui); await flush(); await tick(2);
  return { w, tick, sources, requests, values, events, opened: () => opened,
    state: () => w.__flightdeck.state(), open: () => w.__flightdeck.open(),
    start: (s, id = sid) => { w.S.session = { session_id: id, model: 'example-model' }; w.S.activeStreamId = s; events['turn:start']({ sessionId: id, streamId: s }); },
    emit: (name, data = {}, seq = 1) => sources.at(-1).emit(name, data, seq), query: selector => w.document.querySelector(selector) };
}

test('ended streams close and are not reattached by the host watcher', async t => {
  const h = await harness(t, { stream: 'one' }); assert.equal(h.sources.length, 1);
  h.emit('stream_end'); assert.equal(h.sources[0].closed, true); await h.tick(5000); assert.equal(h.sources.length, 1);
  h.start('two'); assert.equal(h.sources.length, 2); h.sources[1].failClosed(); await h.tick(2000); assert.equal(h.sources.length, 2);
});

test('delayed completion from an earlier turn must not close the new stream', async t => {
  const h = await harness(t, { stream: 'old' }); h.events['turn:complete']({ sessionId: 'parent', streamId: 'old' });
  h.start('new'); const newer = h.sources.at(-1); await h.tick(1500);
  assert.equal(newer.closed, false, 'stale turn-complete timer closed current stream');
});

test('late events from an obsolete source cannot mutate the newer turn', async t => {
  const h = await harness(t, { stream: 'old' }); const old = h.sources[0]; h.start('new');
  old.emit('tool', { name: 'terminal', tid: 'late', args: { command: 'old' } });
  assert.equal(h.state().turn.streamId, 'new', 'obsolete event changed active turn'); assert.equal(h.state().gate.recent.length, 0);
});

test('late stream_end from an obsolete source cannot close the newer stream', async t => {
  const h = await harness(t, { stream: 'old' }); const old = h.sources[0]; h.start('new'); const newer = h.sources.at(-1);
  old.emit('stream_end'); assert.equal(newer.closed, false, 'obsolete stream_end closed current source');
});

test('agent polls do not overlap and stale session list is ignored', async t => {
  const first = deferred(); const h = await harness(t, { stream: 'one', fetcher: () => first.promise });
  h.emit('tool', { name: 'delegate_task', tid: 'd', args: { goal: 'synthetic task' } }); assert.equal(h.requests.length, 1);
  await h.tick(12000); assert.equal(h.requests.length, 1, 'list fetches overlap');
  h.w.S.session = { session_id: 'other' }; h.w.S.activeStreamId = null; await h.tick(1000);
  if (h.requests[0].options.signal) assert.equal(h.requests[0].options.signal.aborted, true, 'if supported, session change aborts old poll');
  first.resolve(response({ sessions: [{ session_id: 'child', parent_session_id: 'parent', source: 'subagent', created_at: 1700000000, is_streaming: true }] }));
  await flush(); assert.equal(h.state().sessionId, 'other'); assert.equal(h.state().agents.length, 0); assert.equal(h.requests.length, 1);
});

test('late child details do not contaminate the newly selected session', async t => {
  const detail = deferred();
  const h = await harness(t, { stream: 'one', fetcher: url => url.includes('/api/session?') ? detail.promise : Promise.resolve(response({ sessions: [{ session_id: 'child', parent_session_id: 'parent', source: 'subagent', created_at: 1700000000, is_streaming: true }] })) });
  h.emit('tool', { name: 'delegate_task', tid: 'd', args: { goal: 'synthetic task' } }); await flush(); assert.equal(h.requests.length, 2);
  h.w.S.session = { session_id: 'other' }; h.w.S.activeStreamId = null; await h.tick(1000);
  detail.resolve(response({ session: { session_id: 'child', messages: [{ role: 'assistant', content: 'stale answer' }] } }));
  await flush(); assert.equal(h.state().sessionId, 'other'); assert.equal(h.state().agents.length, 0);
});

test('render preserves keyboard focus on changing controls and held pointer targets', async t => {
  const h = await harness(t, { stream: 'one' }); h.open(); h.emit('tool', { name: 'terminal', tid: 'a' }); await h.tick(2);
  let gate = h.query('[data-fd-gate="all"]'); gate.focus(); h.emit('tool', { name: 'terminal', tid: 'b' }, 2); await h.tick(2);
  assert.equal(h.w.document.activeElement, h.query('[data-fd-gate="all"]'));
  gate = h.query('[data-fd-gate="all"]'); gate.dispatchEvent(new h.w.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  h.emit('tool', { name: 'terminal', tid: 'c' }, 3); await h.tick(2); assert.equal(h.query('[data-fd-gate="all"]'), gate);
  h.w.dispatchEvent(new h.w.Event('pointerup')); await h.tick(2); assert.notEqual(h.query('[data-fd-gate="all"]'), gate);
  assert.equal(h.w.document.activeElement, h.query('[data-fd-gate="all"]'));
});

test('agent expansion has accessible buttons and transcript links are not nested', async t => {
  const saved = { v: 1, agents: [{ id: 'a', goal: 'Synthetic', status: 'completed', startedAt: 1700000000000, endedAt: 1700000001000, sessionId: 'child', summary: 'done' }] };
  const h = await harness(t, { initial: { 's:parent': saved } }); h.open();
  const card = h.query('[data-fd-agent]'); assert.equal(card.getAttribute('aria-expanded'), 'false'); card.click();
  const expanded = h.query('[data-fd-agent]'); assert.equal(expanded.getAttribute('aria-expanded'), 'true');
  const link = h.query('[data-fd-session]'); assert.ok(link); assert.equal(link.closest('button'), null);
  let selected; h.w.loadSession = sid => { selected = sid; }; link.click(); assert.equal(selected, 'child');
  expanded.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(h.query('[data-fd-agent]').getAttribute('aria-expanded'), 'false');
});

test('reset requires two taps, keeps focus and saves cleared history', async t => {
  const h = await harness(t, { stream: 'one' }); h.open(); h.emit('tool', { name: 'terminal', tid: 'a' }); await h.tick(2);
  let reset = h.query('[data-fd-reset]'); assert.ok(reset); reset.focus(); reset.click(); reset = h.query('[data-fd-reset]');
  assert.match(reset.getAttribute('aria-label'), /Confirm/); assert.equal(h.w.document.activeElement, reset); assert.ok(h.state().log.length);
  reset.click(); assert.equal(h.state().sessionId, 'parent'); assert.equal(h.state().log.length, 0); assert.equal(h.values['s:parent'].log.length, 0);
});

test('storage evicts old and orphaned sessions while retaining current and UI settings', async t => {
  const initial = { index: Array.from({ length: 22 }, (_, i) => 'old' + i), ui: { tab: 'core' }, 's:orphan': { v: 1 } };
  for (const id of initial.index) initial['s:' + id] = { v: 1, padding: 'x'.repeat(25000) };
  const h = await harness(t, { initial, stream: 'one' }); h.emit('tool', { name: 'terminal', tid: 'a' }); await h.tick(4001);
  assert.ok(h.values['s:parent']); assert.equal(h.values.index.at(-1), 'parent'); assert.ok(h.values.index.length <= 20);
  assert.equal(h.values['s:orphan'], undefined); assert.equal(h.values['s:old0'], undefined); assert.equal(h.values.ui.tab, 'core'); assert.ok(JSON.stringify(h.values).length < 400000);
});

test('mobile strip opens drawer and exposes tab and meter semantics', async t => {
  const h = await harness(t, { compact: true, stream: 'one' }); h.emit('metering', { usage: { context_length: 1000, last_prompt_tokens: 500 } }); await h.tick(2);
  const strip = h.query('#fdStrip'); assert.equal(strip.hidden, false); assert.match(strip.getAttribute('aria-label'), /Opens the Flight panel/);
  strip.click(); assert.equal(h.opened(), 1); const tab = h.query('#fdTab'), panel = h.query('#fdPanel');
  assert.equal(tab.getAttribute('role'), 'tab'); assert.equal(tab.getAttribute('aria-selected'), 'true'); assert.equal(tab.getAttribute('aria-controls'), panel.id); assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
  const meter = h.query('[role="meter"]'); assert.ok(meter); assert.equal(meter.getAttribute('aria-valuenow'), '50');
});
