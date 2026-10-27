// btop page glue (assets/btop.js) in jsdom against a stub of Core's async
// switchPanel contract: navigation races, signal buttons that survive ticks,
// the pointer-down render hold, and the offline live region.
// Runs in this repo (extension/) and in the gallery (extensions/btop/):  node --test <this file>
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ASSETS = ['../extension/assets/', '../extensions/btop/assets/']
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((p) => existsSync(p + 'btop.js'));
const CORE_JS = readFileSync(ASSETS + 'btop-core.js', 'utf8');
const PAGE_JS = readFileSync(ASSETS + 'btop.js', 'utf8');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };

// Core's switchPanel shape: sync bookkeeping first, then awaits panel loaders
// for data panels (the Chat transition awaits nothing).
const CORE_STUB = `
  var _currentPanel = 'chat';
  async function switchPanel(name, opts) {
    const next = name || 'chat';
    if (next === 'chat' && window.__failChat) throw new Error('transition failed');
    _currentPanel = next;
    const main = document.querySelector('main.main');
    Array.from(main.classList).filter((c) => c.startsWith('showing-')).forEach((c) => main.classList.remove(c));
    if (next !== 'chat') { main.classList.add('showing-' + next); await null; await null; }
    return true;
  }
  function _isDesktopWidth() { return true; }
  function _isSidebarCollapsed() { return false; }
  function showToast() {}
`;

function setup() {
  const warns = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('warn', (...a) => warns.push(a.join(' ')));
  virtualConsole.on('jsdomError', (e) => { throw e; });
  const dom = new JSDOM('<!doctype html><html><body>' +
    '<span id="appTitlebarTitle"></span><span id="appTitlebarSub"></span>' +
    '<nav class="rail"><i class="rail-spacer"></i></nav>' +
    '<aside class="sidebar"><nav class="sidebar-nav"></nav><div class="panel-view" id="panelChat"></div><div class="panel-view" id="panelInsights"></div></aside>' +
    '<main class="main"><div id="mainChat"></div></main></body></html>',
  { url: 'https://webui.test/session/abc', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  Object.defineProperty(w.document, 'readyState', { value: 'complete' });   // install synchronously
  const h = { dom, w, warns, timers: new Map(), posts: [], now: 1e12, cpu: 10, start: 77, fail: null, truncated: null };
  let tid = 0;
  w.setTimeout = (fn, ms) => { h.timers.set(++tid, { fn, ms: ms || 0 }); return tid; };
  w.clearTimeout = (id) => { h.timers.delete(id); };
  w.requestAnimationFrame = () => 0;
  w.cancelAnimationFrame = () => {};
  w.Date.now = () => h.now;
  let seq = 0;
  w.fetch = async (url, opts = {}) => {
    let status = 200;
    let body;
    if (url.endsWith('/signal')) { h.posts.push(JSON.parse(opts.body)); body = { ok: true }; }
    else if (url.includes('/api/proc/')) body = { pid: 42, start: h.start, name: 'busy', state: 'R', cmd: 'busy --loop', age: 5, children: [] };
    else if (h.fail) { status = h.fail.status; body = { error: h.fail.error }; }
    else {
      body = { boot: 'b', seq: ++seq, signals: true, host: { hostname: 'box' }, proc_total: 9, truncated: h.truncated,
        now: { cpu: { total: h.cpu }, cores: [h.cpu], ncpu: 1, load: { load: [0, 0, 0] }, mem: {}, disks: [], net: {} },
        history: [{ s: seq, cpu: h.cpu }],
        procs: [{ pid: 42, ppid: 1, name: 'busy', cmd: 'busy --loop', user: 'u', cpu: h.cpu, mem: 1, threads: 1 }], groups: [] };
    }
    return { ok: status < 400, status, json: async () => body };
  };
  w.eval(CORE_STUB);
  w.eval(CORE_JS);
  w.eval(PAGE_JS);
  h.$ = (sel) => w.document.querySelector(sel);
  h.state = () => w.__hermesBtop.state();
  // Run due timers (ticks are scheduled at 0 ms or the 1 s interval; the 5.1 s
  // confirm expiry is left alone), advancing the fake clock by `advance`.
  h.run = async (maxMs = 1000, advance = 1000) => {
    h.now += advance;
    const due = [...h.timers].filter(([, t]) => t.ms <= maxMs);
    due.forEach(([id]) => h.timers.delete(id));
    for (const [, t] of due) t.fn();
    await flush();
  };
  h.press = (el) => el.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  h.release = (el) => el.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, button: 0 }));
  return h;
}

async function openWithDetail() {
  const h = setup();
  await h.w.__hermesBtop.open();
  await h.run();
  h.$('tr[data-pid="42"]').click();
  await flush();
  assert.ok(h.$('[data-sig="TERM"]'), 'detail with signal buttons rendered');
  return h;
}

test('a pending open gives up when another navigation runs during Core\'s transition', async () => {
  const h = setup();
  const open = h.w.__hermesBtop.open();
  await h.w.switchPanel('logs');               // same JS turn as open()
  await open;
  assert.equal(h.state().active, false);
  assert.equal(h.state().currentPanel, 'logs');
  assert.ok(!h.$('main').classList.contains('showing-x-btop'));
  await h.w.__hermesBtop.open();               // an undisturbed open still works
  assert.equal(h.state().active, true);
  assert.equal(h.state().currentPanel, 'chat');
  assert.ok(h.$('main').classList.contains('showing-x-btop'));
});

test('a failed Core transition does not overlay the page', async () => {
  const h = setup();
  h.w.__failChat = true;
  await h.w.__hermesBtop.open();
  assert.equal(h.state().active, false);
  assert.ok(!h.$('main').classList.contains('showing-x-btop'));
  assert.ok(h.warns.some((m) => /panel transition failed/.test(m)));
});

test('signal buttons keep their identity across ticks; confirm carries over and pins start', async () => {
  const h = await openWithDetail();
  const term = h.$('[data-sig="TERM"]');
  h.cpu = 37.5;
  await h.run();
  assert.equal(h.$('[data-sig="TERM"]'), term, 'a tick must not rebuild the button');
  assert.equal(h.$('[data-f="detail"] [data-d="cpu"]').textContent, '37.5%', 'live cpu still updates in place');
  term.click();
  assert.equal(term.textContent, 'confirm TERM?');
  h.cpu = 80;
  await h.run();
  assert.equal(h.$('[data-sig="TERM"]'), term);
  assert.equal(term.textContent, 'confirm TERM?');
  assert.ok(term.classList.contains('hbt-armed'));
  assert.equal(h.posts.length, 0, 'arming alone sends nothing');
  term.click();
  await flush();
  assert.deepEqual(h.posts, [{ signal: 'TERM', start: 77 }]);
});

test('a reused PID disarms, and a stale button cannot arm the new process', async () => {
  const h = await openWithDetail();
  const term = h.$('[data-sig="TERM"]');
  term.click();                                  // armed for start 77
  h.press(term);                                 // pointer goes down on it...
  h.start = 99;                                  // ...the PID now names another process
  await h.run(1000, 2500);                       // tick + detail refresh while pressed
  assert.ok(term.isConnected, 'pressed button is held, not replaced');
  assert.equal(term.textContent, 'term', 'confirm is dropped for a different start time');
  h.release(term);
  term.click();                                  // stale button (drawn for start 77)
  await h.run(0, 0);                             // deferred render after the click
  assert.equal(h.$('[data-f="detail"] .hbt-d-head').dataset.forStart, '99');
  assert.equal(h.$('[data-sig="TERM"]').textContent, 'term', 'the stale click armed nothing');
  h.$('[data-sig="TERM"]').click();
  h.$('[data-sig="TERM"]').click();
  await flush();
  assert.deepEqual(h.posts, [{ signal: 'TERM', start: 99 }], 'only an explicit confirm on the new process sends');
});

test('rows are held while the pointer is down and catch up after the click', async () => {
  const h = setup();
  await h.w.__hermesBtop.open();
  await h.run();
  let row = h.$('tr[data-pid="42"]');
  h.press(row);
  h.cpu = 55;
  await h.run();
  assert.ok(row.isConnected, 'a tick during the press keeps the row');
  assert.match(row.querySelector('.hbt-c-cpu').textContent, /10\.0/, 'held, not yet re-rendered');
  h.release(row);
  row.click();
  assert.equal(h.state().selected, 42, 'the click reached the row');
  // a press that ends without a click still catches up once released
  row = h.$('tr[data-pid="42"]');
  h.press(row);
  h.cpu = 66;
  await h.run();
  assert.match(h.$('tr[data-pid="42"] .hbt-c-cpu').textContent, /55\.0/);
  h.release(row);
  await h.run(0, 0);
  assert.match(h.$('tr[data-pid="42"] .hbt-c-cpu').textContent, /66\.0/);
});

test('offline notice: announced once via a rendered live region, ticker outside it', async () => {
  const h = setup();
  await h.w.__hermesBtop.open();
  await h.run();
  h.fail = { status: 502, error: 'sidecar unreachable' };
  await h.run(10000);
  const live = h.$('.hbt-notice-live');
  assert.equal(live.getAttribute('role'), 'status');
  assert.ok(!live.hidden && !live.closest('[hidden]'), 'the live region itself is never hidden');
  const msg = h.$('[data-f="noticeMsg"]');
  assert.match(msg.textContent, /sidecar unreachable/);
  const first = msg.firstChild;
  await h.run(10000, 5000);
  assert.equal(msg.firstChild, first, 'retries do not rewrite the announced message');
  assert.equal(h.$('[data-f="noticeAgo"]').getAttribute('aria-hidden'), 'true');
  assert.match(h.$('[data-f="noticeAgo"]').textContent, /last update/);
});

test('glyph buttons have names; trimmed process list says so on the page', async () => {
  const h = setup();
  h.truncated = { procs: 400, history: 0, budget: 458752 };
  await h.w.__hermesBtop.open();
  await h.run();
  for (const act of ['interval', 'graph', 'pause', 'reverse']) {
    assert.ok(h.$('[data-act="' + act + '"]').getAttribute('aria-label'), act + ' has an aria-label');
  }
  assert.match(h.$('[data-f="procCount"]').textContent, /busiest 1 shown/);
  const filter = h.$('[data-f="filter"]');
  filter.value = 'nomatch';
  filter.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.match(h.$('.hbt-empty').textContent, /among the busiest 1/);
});
