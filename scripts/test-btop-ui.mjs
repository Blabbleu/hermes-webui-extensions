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
  window.__toasts = [];
  function showToast(msg, ms, type) { window.__toasts.push({ msg, ms, type }); }
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
  h.urls = [];
  w.fetch = async (url, opts = {}) => {
    h.urls.push((opts.method || 'GET') + ' ' + url);
    let status = 200;
    let body;
    if (url.endsWith('/signal')) { h.posts.push(JSON.parse(opts.body)); body = { ok: true }; }
    else if (url.includes('/api/proc/')) {
      if (h.detailStatus) status = h.detailStatus;
      body = Object.assign({ pid: 42, start: h.start, name: 'busy', state: 'R', cmd: 'busy --loop', age: 5, children: [] }, h.detail || {});
    }
    else if (h.fail) { status = h.fail.status; body = { error: h.fail.error }; }
    else {
      body = { boot: 'b', seq: ++seq, signals: true, host: { hostname: 'box' }, proc_total: h.total === undefined ? 9 : h.total, truncated: h.truncated,
        now: { cpu: { total: h.cpu }, cores: [h.cpu], ncpu: 1, load: { load: [0, 0, 0] }, mem: {}, disks: [], net: {} },
        history: [{ s: seq, cpu: h.cpu }],
        procs: h.procs || [{ pid: 42, ppid: 1, name: 'busy', cmd: 'busy --loop', user: 'u', cpu: h.cpu, mem: 1, threads: 1 }], groups: [] };
      if (h.patchSnap) h.patchSnap(body);
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
  const t = h.w.__toasts.find((x) => x.type === 'error');
  assert.ok(t, 'the failure is surfaced as an error toast, not only in the console');
  assert.match(t.msg, /Could not open the system monitor: transition failed/);
  assert.equal(t.ms, undefined, 'type goes in the third slot; Core picks the duration');
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
  assert.equal(h.$('[data-act="reverse"]').getAttribute('aria-label'), 'Reverse sort order, currently descending');
  assert.match(h.$('[data-f="procCount"]').textContent, /busiest 1 shown/);
  const filter = h.$('[data-f="filter"]');
  filter.value = 'nomatch';
  filter.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  assert.match(h.$('.hbt-empty').textContent, /among the busiest 1 shown; quieter processes were trimmed/);
});

// ── phone layout hooks: the CSS drops or compresses these spans at narrow
//    widths, so the markup must carry them while the visible text stays the same

test('" procs" sits in a droppable span only while the list is trimmed', async () => {
  const h = setup();
  await h.w.__hermesBtop.open();
  await h.run();
  const pc = h.$('[data-f="procCount"]');
  assert.equal(pc.textContent, '9 procs');
  assert.ok(!pc.classList.contains('hbt-pc-cut'), 'untrimmed: nothing to make room for');
  h.truncated = { procs: 400, history: 0, budget: 458752 };
  await h.run();
  assert.equal(pc.textContent, '9 procs · busiest 1 shown', 'text unchanged for screen readers and tests');
  assert.ok(pc.classList.contains('hbt-pc-cut'));
  assert.equal(pc.querySelector('.hbt-pc-word').textContent, ' procs');
  h.truncated = null;
  await h.run();
  assert.ok(!pc.classList.contains('hbt-pc-cut'), 'class clears when the cut goes away');
});

test('the process count is text: a hostile proc_total cannot inject markup', async () => {
  const h = setup();
  h.total = '<img src=x onerror="window.__pwned=1">';
  h.truncated = { procs: 400, history: 0, budget: 458752 };
  await h.w.__hermesBtop.open();
  await h.run();
  const pc = h.$('[data-f="procCount"]');
  assert.equal(pc.querySelector('img'), null, 'no element built from proc_total');
  assert.match(pc.textContent, /^<img src=x onerror="window.__pwned=1"> procs · busiest 1 shown$/);
  assert.ok(pc.querySelector('.hbt-pc-word'), 'the droppable word span is still there');
});

test('numbers from the sidecar are text everywhere, not markup', async () => {
  // Whatever answers on the sidecar port is not authenticated, so a
  // non-numeric value in a numeric field must not become markup. The leading
  // quote also catches attribute-context sinks (data-pid="…").
  const x = (f) => '"><img data-f="' + f + '" src=x>';
  const h = setup();
  // (A non-integer pid is dropped on arrival; see the next test.)
  h.procs = [
    { pid: 42, ppid: 1, name: 'busy', cmd: 'busy', user: 'u', cpu: 1, mem: 1, threads: x('threads') },
    { pid: 43, ppid: 42, name: 'kid', cmd: 'kid', user: 'u', cpu: 1, mem: 1, threads: 1 },
  ];
  h.patchSnap = (b) => {
    b.proc_total = x('proc_total');
    b.now.procs_running = x('procs_running');
    b.now.disks = [{ mount: '/', dev: 'sda', fs: 'ext4', total: 100, used: 50, read: 1, write: 1, busy: x('busy') }];
    b.groups = [{ name: 'agent', procs: x('g.procs'), cpu: 1, mem: 1, own: 0 }];
  };
  h.detail = { ppid: x('ppid'), threads: x('d.threads'), nice: x('nice'), fds: x('fds'),
    ctx_vol: x('ctx_vol'), ctx_invol: x('ctx_invol'), children: [{ pid: x('c.pid'), name: 'kid' }], user: 'u' };
  await h.w.__hermesBtop.open();
  await h.run();
  h.$('[data-act="tree"]').click();
  await h.run();
  h.$('tr[data-pid="42"]').click();
  await flush();
  await h.run();
  const injected = [...h.w.document.querySelectorAll('img')].map((i) => i.dataset.f);
  assert.deepEqual(injected, [], 'elements built from sidecar numbers: ' + injected.join(', '));
  assert.match(h.$('[data-f="detail"]').textContent, /<img data-f="ppid" src=x>/, 'the hostile value is shown as text');
  const sideG = h.$('.hbt-side-g');
  assert.ok(sideG && /<img data-f="g\.procs"/.test(sideG.textContent), 'sidebar group count rendered as text');
});

test('a pid that is not a positive integer never selects, renders, or reaches a request path', async () => {
  const h = setup();
  const evil = '../../../../../health/restart#"><img data-f="pid" src=x>';
  h.procs = [
    { pid: evil, ppid: 1, name: 'evil', cmd: 'evil', user: 'u', cpu: 99, mem: 1, threads: 1 },
    { pid: 42, ppid: 1, name: 'busy', cmd: 'busy', user: 'u', cpu: 1, mem: 1, threads: 1 },
    { pid: 4.5, ppid: 1, name: 'frac', cmd: 'frac', user: 'u', cpu: 50, mem: 1, threads: 1 },
  ];
  await h.w.__hermesBtop.open();
  await h.run();
  assert.deepEqual([...h.w.document.querySelectorAll('tr[data-pid]')].map((tr) => tr.dataset.pid), ['42'], 'only the valid row is listed');
  // keyboard selection walks the listed rows only
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowDown']) {
    h.w.document.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: k, bubbles: true }));
    await flush();
    const sel = h.state().selected;
    assert.ok(sel == null || sel === 42, 'selected stays a listed pid, got ' + sel);
  }
  // a detail answer for a different pid is not trusted: no signal buttons, and
  // nothing leaves the sidecar path even if a stale button is clicked
  h.detail = { pid: evil, start: 77 };
  if (h.state().selected !== 42) h.$('tr[data-pid="42"]').click();
  await flush();
  await h.run();
  assert.equal(h.$('[data-sig]'), null, 'no signal buttons for a mismatched detail');
  assert.match(h.$('[data-f="detail"]').textContent, /unexpected answer from the sidecar/);
  // a failed detail load renders the selected pid as text
  h.detail = null;
  h.detailStatus = 404;
  h.$('[data-act="close-detail"]').click();
  await flush();
  h.$('tr[data-pid="42"]').click();
  await flush();
  assert.equal(h.$('[data-f="detail"] .hbt-d-head b').textContent, '42');
  assert.deepEqual([...h.w.document.querySelectorAll('img')].map((i) => i.dataset.f), []);
  const off = h.urls.filter((u) => !/^(GET|POST) \/api\/extensions\/btop\/sidecar\/api\/(snapshot\?|proc\/42(\/signal)?$)/.test(u));
  assert.deepEqual(off, [], 'every request stays on the sidecar path with a numeric pid');
});

test('tree guides and toggle brackets are spans; the drawn prefix text is unchanged', async () => {
  const h = setup();
  const p = (pid, ppid, name) => ({ pid, ppid, name, cmd: name, user: 'u', cpu: 1, mem: 1, threads: 1 });
  h.procs = [p(1, 0, 'init'), p(42, 1, 'busy'), p(43, 42, 'kid'), p(44, 43, 'grandkid')];
  await h.w.__hermesBtop.open();
  await h.run();
  h.$('[data-act="tree"]').click();
  await h.run();
  const cell = (pid) => h.$('tr[data-pid="' + pid + '"] .hbt-tree');
  assert.equal(cell(42).textContent, '└─[-]', 'depth one: branch + toggle, no guide span');
  assert.equal(cell(42).querySelector('.hbt-lead'), null);
  assert.equal(cell(44).textContent, '    └─', 'depth three: two levels of guides, then the branch');
  assert.equal(cell(44).querySelector('.hbt-lead').textContent, '    ');
  const tw = h.$('tr[data-pid="42"] .hbt-tw');
  assert.equal(tw.textContent, '[-]');
  assert.equal(tw.querySelectorAll('.hbt-twb').length, 2, 'brackets are separate so phones can hide them');
  assert.equal(tw.querySelector('.hbt-twg').textContent, '-', 'the glyph is separate so phones can draw a chevron');
  assert.equal(tw.getAttribute('aria-label'), 'Collapse busy');
});

test('detail: cwd, exe and children span the row (wrapped, not ellipsized)', async () => {
  const h = setup();
  h.detail = { cwd: '/srv/' + 'deep/'.repeat(20), exe: '/usr/bin/busy', children: [{ pid: 43, name: 'kid' }], user: 'u' };
  await h.w.__hermesBtop.open();
  await h.run();
  h.$('tr[data-pid="42"]').click();
  await flush();
  const wide = [...h.w.document.querySelectorAll('[data-d="grid"] .hbt-d-wide')].map((e) => e.textContent.split(' ')[0]);
  assert.deepEqual(wide, ['cwd', 'exe', 'children']);
  const user = [...h.w.document.querySelectorAll('[data-d="grid"] > div')].find((e) => e.textContent.startsWith('user'));
  assert.ok(user && !user.classList.contains('hbt-d-wide'), 'short fields keep the two-column grid');
  const cwd = h.$('[data-d="grid"] .hbt-d-wide code');
  assert.equal(cwd.textContent, h.detail.cwd, 'the path text is unchanged (copy/paste)');
  assert.equal(cwd.querySelectorAll('wbr').length, (h.detail.cwd.match(/\//g) || []).length, 'a break point after every slash');
});

test('detail: a byte value keeps its number and unit together; hostile paths stay text', async () => {
  const h = setup();
  h.detail = { io_read: 2650000000, io_write: 1100000000, cwd: '/tmp/<img src=x>/a', user: 'u' };
  await h.w.__hermesBtop.open();
  await h.run();
  h.$('tr[data-pid="42"]').click();
  await flush();
  const io = [...h.w.document.querySelectorAll('[data-d="grid"] > div')].find((e) => e.textContent.startsWith('io r/w'));
  assert.ok(io, 'io row rendered');
  assert.match(io.textContent, /^io r\/w \S+\u00a0\S+ \/ \S+\u00a0\S+$/, 'only the separator can wrap');
  const cwd = h.$('[data-d="grid"] .hbt-d-wide code');
  assert.equal(cwd.querySelector('img'), null, 'escaped before the break points are added');
  assert.equal(cwd.textContent, '/tmp/<img src=x>/a');
});
