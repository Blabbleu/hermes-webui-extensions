#!/usr/bin/env node
/* Behavior tests for the project-folders (lite) extension.
 *
 * Loads extensions/project-folders/assets/project-folders.js into a jsdom
 * harness that mirrors the core WebUI sidebar contracts verified against
 * core 77c8fc174:
 *   - classic DOM anchors (#panelChat/.panel-head-actions/#sessionSearch/
 *     #sessionSearchClear/#sessionList);
 *   - core globals the extension feature-checks (S, newSession,
 *     _openSidebarSession, showToast, registerHermesSessionOpenHandler,
 *     window.refreshSessionList, showConfirmDialog/showPromptDialog);
 *   - a throwing EventSource stub: the lite extension must NEVER open a
 *     second /api/sessions/events stream.
 *
 * Covers: grouping (incl. unknown-project fallback), pagination window +
 * active-row visibility, active highlight, new-chat binding options,
 * core session-open path, search clear sync without an 'input' event,
 * hash-skipped repaints / row identity / focus restore / queued follow-up
 * refresh, row menu actions (delete confirm gating, title regeneration),
 * the header mode toggle, and the HERMES.md save-gating contract.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(
  new URL('../extensions/project-folders/assets/project-folders.js', import.meta.url),
  'utf8'
);

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks += 1;
}
function checkEqual(actual, expected, message) {
  assert.equal(actual, expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  checks += 1;
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function makeHarness({ projects = [], sessions = [], session = null, dialogs = null, coreMenu = false } = {}) {
  const dom = new JSDOM(
    `<div id="panelChat">
       <div class="panel-head"><span>Chat</span>
         <div class="panel-head-actions"><button id="btnNewChat" class="panel-head-btn">+</button></div>
       </div>
       <div class="session-search sidebar-search"><input id="sessionSearch" type="search">
         <button id="sessionSearchClear" type="button" hidden></button></div>
       <div class="session-list" id="sessionList"></div>
     </div>`,
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const w = dom.window;
  const h = {
    dom, w, d: w.document,
    fetches: [], posts: [], opens: [], loadCalls: [], newSessionCalls: [],
    toasts: [], esAttempted: false, coreRefreshes: 0, drawerCloses: 0,
    prompts: [], confirms: [], holdFetch: null,
    projects, sessions,
  };
  let projectsData = projects;
  let sessionsData = sessions;
  h.setData = (p, s) => {
    if (p !== undefined) projectsData = p;
    if (s !== undefined) sessionsData = s;
  };
  w.S = { session, activeProfile: 'default' };
  w.showToast = (m) => h.toasts.push(String(m));
  w.registerHermesSessionOpenHandler = (fn) => { h.sessionOpenHooks = h.sessionOpenHooks || []; h.sessionOpenHooks.push(fn); return true; };
  w._openSidebarSession = (s) => h.opens.push(s && s.session_id);
  w.loadSession = (sid) => { h.loadCalls.push(sid); };
  w.newSession = async (flash, options) => { h.newSessionCalls.push({ flash, options }); };
  w.closeMobileSidebar = () => { h.drawerCloses += 1; };
  w.refreshSessionList = function () { h.coreRefreshes += 1; };
  w.showConfirmDialog = (opts) => { h.confirms.push(opts); return (dialogs && dialogs.confirm) || Promise.resolve(false); };
  // core's own delete flow (confirm + cleanup + open-chat handling live there)
  h.coreDeletes = [];
  w.deleteSession = async (sid) => { h.coreDeletes.push(sid); return true; };
  h.workspaceSwitches = [];
  w.switchToWorkspace = async (path) => { h.workspaceSwitches.push(path); };
  w.showPromptDialog = (opts) => { h.prompts.push(opts); return (dialogs && dialogs.prompt) || Promise.resolve(null); };
  if (coreMenu) {
    // core's menu builder surface (_buildSessionAction returns a button;
    // _mountSessionActionMenu appends and positions)
    w._buildSessionAction = (label, meta, icon, onSelect) => {
      const b = w.document.createElement('button');
      b.className = 'ws-opt session-action-opt';
      b.textContent = label;
      b.onclick = (e) => onSelect();
      return b;
    };
    w._mountSessionActionMenu = (menu, session, anchor) => {
      h.mountedMenus = h.mountedMenus || [];
      h.mountedMenus.push(menu);
      w.document.body.appendChild(menu);
    };
    // core's close retires the currently mounted menu
    w.closeSessionActionMenu = () => {
      const m = h.mountedMenus && h.mountedMenus[h.mountedMenus.length - 1];
      if (m && m.isConnected) m.remove();
    };
  }
  w.EventSource = function () { h.esAttempted = true; throw new Error('extension must not open EventSource'); };
  w.fetch = async (path, opts) => {
    const url = String(path);
    h.fetches.push(url);
    if (h.holdFetch) await h.holdFetch;
    if (opts && opts.method === 'POST') {
      h.posts.push({ url, body: JSON.parse(opts.body || '{}') });
      if (h.holdPost) await h.holdPost;
      return { ok: true, status: 200, json: async () => ({ ok: true, session: { session_id: 'new-1' } }) };
    }
    if (h.failLists && (url.startsWith('/api/projects') || url.startsWith('/api/sessions'))) {
      return { ok: false, status: 503, json: async () => ({ error: 'down' }) };
    }
    if (url.startsWith('/api/projects')) return { ok: true, status: 200, json: async () => ({ projects: projectsData }) };
    if (url.startsWith('/api/sessions')) return { ok: true, status: 200, json: async () => ({ sessions: sessionsData }) };
    if (url.startsWith('/api/file?')) {
      if (h.holdFile) await h.holdFile;
      if (h.mdMissing) return { ok: false, status: 404, json: async () => ({ error: 'Not a file: HERMES.md' }) };
      if (h.mdRefused) return { ok: false, status: 404, json: async () => ({ error: 'Path traversal blocked: /ws/alpha/HERMES.md' }) };
      return { ok: true, status: 200, json: async () => ({ path: 'HERMES.md', content: '# ctx', size: 5, lines: 1 }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'unknown ' + url }) };
  };
  w.matchMedia = () => ({ matches: false });
  w.eval(source);
  h.pf = () => w.__PF__;
  h.rows = () => [...h.d.querySelectorAll('#pf-folders .pf-row')];
  h.rowFor = (sid) => h.d.querySelector(`#pf-folders .pf-row[data-sid="${sid}"]`);
  h.groupBody = (key) => h.d.querySelector(`#pf-folders .pf-group[data-key="${key}"] .pf-group-body`);
  h.refresh = async () => { await w.__PF__.runRefresh(); };
  h.close = () => { try { dom.window.close(); } catch (_) {} };
  return h;
}

async function boot(h) {
  await tick(20); // setTimeout(boot,0) + async fetch round-trips
  await h.refresh();
}

function session(sid, extra) {
  return Object.assign({
    session_id: sid, title: sid, last_message_at: 1000 - Number(String(sid).slice(-2) || 0),
    project_id: null, workspace: '/ws/default', pinned: false,
  }, extra || {});
}

async function main() {
  // ── 1. grouping incl. unknown-project fallback ─────────────────────────
  {
    const projects = [{ project_id: 'p1', name: 'Alpha', color: '#f00' }];
    const sessions = [
      session('s1', { project_id: 'p1' }),
      session('s2', { project_id: null }),
      session('s3', { project_id: 'ghost-project' }), // unknown -> Unassigned
      session('s4', { project_id: 'p1', archived: true }), // archived -> out of scope
    ];
    const h = makeHarness({ projects, sessions });
    await boot(h);
    const groups = [...h.d.querySelectorAll('#pf-folders .pf-group')].map((g) => g.dataset.key);
    checkEqual(groups.join(','), 'p1,unassigned', 'project group then Unassigned');
    checkEqual(h.groupBody('p1').querySelectorAll('.pf-row').length, 1, 'archived sessions stay out of the folder view');
    checkEqual(h.groupBody('unassigned').querySelectorAll('.pf-row').length, 2, 'null + unknown project_id both land in Unassigned');
    // insertion point: folders go AFTER the search box, BEFORE #sessionList
    const panel = h.d.getElementById('panelChat');
    const kids = [...panel.children].map((n) => n.id);
    check(kids.indexOf('pf-folders') === kids.indexOf('sessionList') - 1, '#pf-folders is inserted immediately before #sessionList');
    check(kids.indexOf('pf-folders') > 1, 'core search box stays above the folder list');
    const unGear = h.d.querySelector('#pf-folders .pf-group[data-key="unassigned"] .pf-group-gear');
    checkEqual(unGear.style.visibility, 'hidden', 'Unassigned keeps the gear slot (visibility) so count badges align');
    checkEqual(unGear.tabIndex, -1, 'the hidden Unassigned gear is not a tab stop');
    // toggle icon exists next to the core "+"
    const head = h.d.querySelector('#panelChat .panel-head-actions');
    check(head.querySelector('#pf-mode-toggle'), 'mode toggle injected into panel-head-actions');
    check(head.querySelector('#pf-mode-toggle') === head.firstChild, 'toggle sits beside the core "+" button');
    const tog = head.querySelector('#pf-mode-toggle');
    check(tog.classList.contains('has-tooltip') && tog.getAttribute('data-tooltip'), 'toggle uses core\'s tooltip idiom (data-tooltip), like the adjacent "+"');
    check(!tog.hasAttribute('title'), 'no native title tooltip doubling core\'s styled one');
    h.close();
  }

  // ── 2. pagination window + active-row visibility + highlight ──────────
  {
    const projects = [{ project_id: 'p1', name: 'Alpha' }];
    const sessions = [];
    for (let i = 1; i <= 7; i++) sessions.push(session('a' + i, { project_id: 'p1', last_message_at: 1000 - i, title: 'row ' + i }));
    const active = sessions[5]; // a6 sorts just below the 5-row page window
    const h = makeHarness({ projects, sessions, session: { session_id: active.session_id } });
    await boot(h);
    const body = h.groupBody('p1');
    checkEqual(body.querySelectorAll('.pf-row').length, 6, '5-row window extended to keep the active row visible');
    check(h.rowFor('a6').classList.contains('pf-active'), 'active row is highlighted');
    checkEqual(h.rowFor('a6').querySelector('.pf-row-open').getAttribute('aria-current'), 'page', 'active row announces aria-current');
    const showLess = body.querySelector('.pf-showless');
    check(showLess, 'expanded window past PAGE_SIZE shows Show less');
    // with no active chat the plain 5-row window + Show more applies
    h.w.S.session = null;
    await h.refresh();
    const more = h.groupBody('p1').querySelector('.pf-showmore');
    checkEqual(h.groupBody('p1').querySelectorAll('.pf-row').length, 5, 'without an active row the page window is exactly PAGE_SIZE');
    check(more && /Show 2 more · 2 remaining/.test(more.textContent), 'Show more label counts remaining rows');
    more.click();
    checkEqual(h.groupBody('p1').querySelectorAll('.pf-row').length, 7, 'Show more reveals the next page');
    check(h.groupBody('p1').querySelector('.pf-showless'), 'Show less appears once expanded');
    h.groupBody('p1').querySelector('.pf-showless').click();
    checkEqual(h.groupBody('p1').querySelectorAll('.pf-row').length, 5, 'Show less collapses back to PAGE_SIZE');
    h.close();
  }

  // ── 3. new chat uses core newSession with binding merge done for us ───
  {
    const projects = [{
      project_id: 'p1', name: 'Alpha', default_workspace: '/ws/alpha',
      model: 'some/model', model_provider: 'acme',
    }, { project_id: 'p2', name: 'Beta' }];
    const sessions = [session('s1', { project_id: 'p1' })];
    const h = makeHarness({ projects, sessions });
    await boot(h);
    const plus = h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-group-plus');
    plus.click();
    await tick(5);
    checkEqual(h.newSessionCalls.length, 1, 'project "+" goes through core newSession');
    const opts = h.newSessionCalls[0].options;
    checkEqual(h.newSessionCalls[0].flash, false, 'project quick-create does not flash (matches core)');
    checkEqual(opts.project_id, 'p1', 'project_id forwarded');
    checkEqual(opts.workspace, '/ws/alpha', 'bound workspace forwarded (core skips its merge when project_id is present)');
    checkEqual(opts.model, 'some/model', 'bound model forwarded');
    checkEqual(opts.model_provider, 'acme', 'bound provider forwarded');
    // unassigned new-chat null semantics are covered in harness #4.
    check(!h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-newchat'),
      'non-empty folders rely on the header "+" (no duplicate inline New chat row)');
    h.d.querySelector('#pf-folders .pf-group[data-key="p2"] .pf-newchat').click();
    await tick(5);
    checkEqual(h.newSessionCalls[1].options.project_id, 'p2', 'empty-folder New chat here passes the project');
    h.close();
  }

  // ── 4. unassigned "+" sends project_id null (no workspace key) ────────
  {
    const projects = [{ project_id: 'p1', name: 'Alpha' }];
    const sessions = [session('s2', { project_id: null })];
    const h = makeHarness({ projects, sessions });
    await boot(h);
    h.d.querySelector('#pf-folders .pf-group[data-key="unassigned"] .pf-group-plus').click();
    await tick(5);
    const opts = h.newSessionCalls[0].options;
    checkEqual(opts.project_id, null, 'Unassigned new chat sends an explicit project_id null');
    check(!('workspace' in opts), 'no workspace override for unassigned chats');
    checkEqual(h.drawerCloses, 1, 'mobile drawer closed after new session (closeMobileSidebar)');
    // core's empty-chat reuse guard (#1171) is honored for unscoped "+"
    h.w._currentSessionIsReusableEmptyChat = () => true;
    h.w.S.session = { session_id: 'empty-1', project_id: null };
    const drawerBefore = h.drawerCloses;
    h.d.querySelector('#pf-folders .pf-group[data-key="unassigned"] .pf-group-plus').click();
    await tick(5);
    checkEqual(h.newSessionCalls.length, 1, 'unassigned "+" reuses the open empty unassigned chat instead of minting a new one');
    checkEqual(h.drawerCloses, drawerBefore + 1, 'reuse path also closes the mobile drawer');
    // ...but never an empty chat that is filed under a project
    h.w.S.session = { session_id: 'empty-2', project_id: 'p1' };
    h.d.querySelector('#pf-folders .pf-group[data-key="unassigned"] .pf-group-plus').click();
    await tick(5);
    checkEqual(h.newSessionCalls.length, 2, 'unassigned "+" does not reuse an empty chat that belongs to a project');
    checkEqual(h.newSessionCalls[1].options.project_id, null, 'the new chat is explicitly unassigned');
    h.close();
  }

  // ── 5. row open goes through _openSidebarSession; no EventSource ──────
  {
    const h = makeHarness({ projects: [], sessions: [session('s1')] });
    await boot(h);
    h.rowFor('s1').querySelector('.pf-row-open').click();
    checkEqual(h.opens.join(','), 's1', 'row opens via core _openSidebarSession');
    checkEqual(h.loadCalls.length, 0, 'loadSession fallback is not used when the core open path exists');
    checkEqual(h.esAttempted, false, 'extension never opens an EventSource');
    // sidebar data fetch mirrors core's scoping params
    check(h.fetches.some((u) => u.includes('sidebar_source=webui') && u.includes('exclude_hidden=1')),
      'session fetch mirrors core sidebar scoping (WebUI source, hidden rows excluded)');
    h.close();
  }

  // ── 5b. window.refreshSessionList wrapper: transparent + drives refresh ─
  {
    const h = makeHarness({ projects: [], sessions: [session('s1')] });
    await boot(h);
    const before = h.fetches.filter((u) => u.startsWith('/api/sessions')).length;
    const returned = h.w.refreshSessionList('unit-test', { force: true });
    checkEqual(h.coreRefreshes, 1, 'core refreshSessionList still executes (wrapper is a pass-through)');
    checkEqual(returned, undefined, 'wrapper returns the original value');
    await tick(500); // wrapper schedules requestRefresh(350)
    const after = h.fetches.filter((u) => u.startsWith('/api/sessions')).length;
    check(after > before, 'core-driven refresh triggers the folder refresh (no second EventSource needed)');
    // session-open hook path: repaints highlight from cached state (core's
    // own list refresh, caught by the wrapper, is what pulls new rows)
    check((h.sessionOpenHooks || []).length >= 1, 'registers a core session-open handler');
    h.w.S = { session: { session_id: 's1' }, activeProfile: 'default' };
    h.sessionOpenHooks[0]('s1', { session_id: 's1' }, { loaded: true });
    check(!!h.d.querySelector('#pf-folders .pf-row.pf-active[data-sid="s1"]'),
      'session-open hook highlights the opened row');
    h.close();
  }

  // ── 6. search sync: input event AND core clear (no input event) ───────
  {
    const sessions = [session('s1', { title: 'Quarterly report' }), session('s2', { title: 'Groceries' })];
    const h = makeHarness({ projects: [], sessions });
    await boot(h);
    const input = h.d.getElementById('sessionSearch');
    input.value = 'report';
    input.dispatchEvent(new h.w.Event('input'));
    await tick(180); // extension-side 120ms debounce
    checkEqual(h.d.querySelectorAll('#pf-folders .pf-row').length, 1, 'typing filters the folder list');
    // core's clear button sets value + filterSessions() WITHOUT an input event
    input.value = '';
    h.d.getElementById('sessionSearchClear').hidden = true; // hidden-attr mutation the ext watches
    await tick(180);
    checkEqual(h.d.querySelectorAll('#pf-folders .pf-row').length, 2, 'programmatic clear resyncs the folder list');
    h.close();
  }

  // ── 7. hash-skipped repaints, row identity, focus restore ─────────────
  {
    const sessions = [session('s1'), session('s2')];
    const h = makeHarness({ projects: [], sessions });
    await boot(h);
    const rowA = h.rowFor('s1');
    await h.refresh(); // identical payload -> hash unchanged
    check(rowA === h.rowFor('s1'), 'unchanged snapshot never rebuilds rows');
    // data change reconciles in place; focus on a surviving control stays put
    const s2Open = h.rowFor('s2').querySelector('.pf-row-open');
    s2Open.focus();
    h.setData(undefined, [...sessions.map((x) => x.session_id === 's2' ? session('s2', { last_message_at: 5000 }) : x), session('s3')]);
    await h.refresh();
    check(h.w.document.activeElement === h.rowFor('s2').querySelector('.pf-row-open'),
      'focus is restored to the same control after a reconciled repaint');
    check(h.rowFor('s3'), 'new session appears without a full rebuild');
    check(h.rowFor('s1') === rowA, 'existing row element is reused across reconcile');
    h.close();
  }

  // ── 8. refresh during in-flight fetch queues exactly one follow-up ────
  {
    const h = makeHarness({ projects: [], sessions: [session('s1')] });
    let resolveHold;
    h.holdFetch = new Promise((r) => { resolveHold = r; });
    await tick(5); // boot()'s fetch is now in flight, blocked on holdFetch
    h.w.__PF__.requestRefresh(0);
    h.w.__PF__.requestRefresh(0); // coalesced into the single queued follow-up
    await tick(5);
    resolveHold();
    h.holdFetch = null;
    await tick(120);
    const listFetches = h.fetches.filter((u) => u.startsWith('/api/sessions')).length;
    checkEqual(listFetches, 2, 'one follow-up round after the in-flight fetch (not zero, not two)');
    h.close();
  }

  // ── 9. row menu: core builder preferred; delete gated by confirm ─────
  {
    const sessions = [session('s1')];
    const h = makeHarness({ projects: [{ project_id: 'p1', name: 'Alpha' }], sessions, coreMenu: true, dialogs: { confirm: Promise.resolve(false) } });
    await boot(h);
    h.rowFor('s1').querySelector('.pf-row-more').click();
    checkEqual((h.mountedMenus || []).length, 1, 'menu uses core session-action menu builder when present');
    const labels = [...h.mountedMenus[0].querySelectorAll('button')].map((b) => b.textContent);
    check(labels.some((l) => l.includes('Alpha')), 'move-to-project entries list core projects');
    check(labels.some((l) => l.includes('Regenerate title')), 'menu offers Regenerate title (core endpoint)');
    // delete is core's own deleteSession (its confirm, cleanup, open-chat handling)
    const del = [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('Delete'));
    del.onclick({});
    await tick(10);
    checkEqual(h.coreDeletes.join(','), 's1', 'delete delegates to core deleteSession(session_id)');
    check(!h.posts.some((p) => p.url === '/api/session/delete'), 'no hand-rolled /api/session/delete POST');
    checkEqual(h.confirms.length, 0, 'no duplicate extension-side confirm (core asks)');
    h.close();
  }
  {
    const h = makeHarness({ projects: [], sessions: [session('s1')], coreMenu: true, dialogs: { confirm: Promise.resolve(true) } });
    h.w.S = { session: { session_id: 's1' }, activeProfile: 'default' };
    await boot(h);
    h.rowFor('s1').querySelector('.pf-row-more').click();
    const fetchesBefore = h.fetches.filter((u) => u.startsWith('/api/sessions')).length;
    const del = [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('Delete'));
    del.onclick({});
    await tick(200);
    checkEqual(h.coreDeletes.join(','), 's1', 'deleting the open chat is core deleteSession too (core moves off the dead id)');
    check(h.fetches.filter((u) => u.startsWith('/api/sessions')).length > fetchesBefore, 'folder view refreshes after core delete');
    // regenerate title -> core endpoint with prefer_latest
    h.w.S = { session: null, activeProfile: 'default' };
    h.rowFor('s1').querySelector('.pf-row-more').click();
    const regen = [...h.mountedMenus[1].querySelectorAll('button')].find((b) => b.textContent.includes('Regenerate title'));
    regen.onclick({});
    await tick(20);
    const regenPost = h.posts.find((p) => p.url === '/api/session/title/regenerate');
    check(regenPost, 'regenerate uses core title endpoint (no sidecar)');
    checkEqual(regenPost.body.prefer_latest, true, 'regenerate sends prefer_latest');
    h.close();
  }

  // ── 10. fallback menu when core builder is absent ─────────────────────
  {
    const h = makeHarness({ projects: [], sessions: [session('s1')] });
    await boot(h);
    h.rowFor('s1').querySelector('.pf-row-more').click();
    const menu = h.d.querySelector('#pf-folders ~ body .pf-menu, body > .pf-menu');
    check(menu, 'fallback menu renders without core builder');
    checkEqual(menu.getAttribute('role'), 'menu', 'fallback menu has role=menu');
    const btns = [...menu.querySelectorAll('button')];
    check(btns.length > 0 && btns.every((b) => b.getAttribute('role') === 'menuitem'), 'menu items are role=menuitem buttons');
    h.d.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(!h.d.querySelector('body > .pf-menu'), 'Escape closes the fallback menu');
    h.close();
  }
  {
    // fallback menu whose trigger was rebuilt by a refresh: focus re-homes,
    // never stays on <body>
    const h = makeHarness({ projects: [{ project_id: 'p1', name: 'Alpha' }], sessions: [session('s1'), session('s2')] });
    await boot(h);
    h.rowFor('s1').querySelector('.pf-row-more').click();
    h.setData(undefined, [session('s1', { project_id: 'p1' }), session('s2')]);
    await h.refresh();
    h.d.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(!h.d.querySelector('body > .pf-menu'), 'Escape closes the fallback menu after a refresh');
    checkEqual(h.w.document.activeElement, h.rowFor('s1').querySelector('.pf-row-more'),
      'fallback menu close re-homes focus to the rebuilt trigger');
    h.close();
  }

  // ── 11. header toggle switches modes and persists ─────────────────────
  {
    const h = makeHarness({ projects: [], sessions: [session('s1')] });
    await boot(h);
    check(h.d.body.classList.contains('pf-mode-folders'), 'starts in folders mode');
    h.d.getElementById('pf-mode-toggle').click();
    check(!h.d.body.classList.contains('pf-mode-folders'), 'toggle switches to classic (no always-visible bar)');
    checkEqual(h.w.localStorage.getItem('hermes-pf-mode'), 'classic', 'mode persisted to owned storage key');
    h.d.getElementById('pf-mode-toggle').click();
    check(h.d.body.classList.contains('pf-mode-folders'), 'toggle returns to folders mode');
    h.close();
  }

  // ── 12. HERMES.md via core file API: save gated by successful read ────
  {
    const projects = [{ project_id: 'p1', name: 'Alpha', default_workspace: '/ws/alpha' }];
    const sessions = [session('s1', { project_id: 'p1', workspace: '/ws/alpha' })];
    const h = makeHarness({ projects, sessions, coreMenu: true });
    await boot(h);
    h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-group-gear').click();
    const md = [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('Project instructions'));
    check(md && !md.disabled, 'HERMES.md enabled when a session in the bound workspace exists');
    md.onclick({});
    await tick(30);
    const ta = h.d.querySelector('.pf-dialog .pf-textarea');
    const save = [...h.d.querySelectorAll('.pf-dialog .pf-btn')].find((b) => b.textContent === 'Save');
    check(ta && ta.value === '# ctx', 'HERMES.md read through core GET /api/file');
    checkEqual(save.disabled, false, 'Save enabled after a successful read');
    save.click();
    await tick(10);
    const saved = h.posts.find((p) => p.url === '/api/file/save');
    check(saved && saved.body.content === '# ctx', 'save posts through core /api/file/save');
    checkEqual(saved.body.path, '/ws/alpha/HERMES.md', 'save uses the absolute bound-workspace path (core refuses it if the session moved)');
    check(h.fetches.some((u) => u.startsWith('/api/file?') && u.includes('path=' + encodeURIComponent('/ws/alpha/HERMES.md'))),
      'read uses the same absolute path as the save');
    h.close();
  }
  {
    // missing file: Save must stay disabled (never blank an unread file,
    // and core refuses to create files)
    const projects = [{ project_id: 'p1', name: 'Alpha', default_workspace: '/ws/alpha' }];
    const sessions = [session('s1', { project_id: 'p1', workspace: '/ws/alpha' })];
    const h = makeHarness({ projects, sessions, coreMenu: true });
    h.mdMissing = true;
    await boot(h);
    h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-group-gear').click();
    const md = [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('Project instructions'));
    md.onclick({});
    await tick(30);
    const ta = h.d.querySelector('.pf-dialog .pf-textarea');
    const save = [...h.d.querySelectorAll('.pf-dialog .pf-btn')].find((b) => b.textContent === 'Save');
    check(ta.disabled, 'textarea stays disabled when the read failed');
    checkEqual(save.disabled, true, 'Save stays disabled on 404 (no file creation, no wipe path)');
    check(h.d.querySelector('.pf-dialog .pf-dialog-text').textContent.includes('HERMES.md'), 'missing-file state is explained');
    h.close();
  }

  // ── 13. HERMES.md disabled without a usable session ───────────────────
  {
    const projects = [{ project_id: 'p1', name: 'Alpha', default_workspace: '/ws/alpha' }];
    const sessions = [session('s1', { project_id: 'p1', workspace: '/elsewhere' })];
    const h = makeHarness({ projects, sessions, coreMenu: true });
    await boot(h);
    h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-group-gear').click();
    const md = [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('Project instructions'));
    check(!md.disabled, 'HERMES.md stays enabled (a disabled reason would be tooltip-only on touch)');
    md.onclick({});
    await tick(10);
    check(!h.d.querySelector('.pf-dialog'), 'no dialog without a session in the bound workspace');
    check(h.toasts.some((t) => /Open or create a chat/.test(t)), 'the action explains what is missing');
    h.close();
  }

  // ── 14. read-only sessions get no destructive actions ─────────────────
  {
    const h = makeHarness({ projects: [], sessions: [session('s1', { read_only: true })], coreMenu: true });
    await boot(h);
    h.rowFor('s1').querySelector('.pf-row-more').click();
    const labels = [...h.mountedMenus[0].querySelectorAll('button')].map((b) => b.textContent);
    check(!labels.some((l) => l.includes('Delete')), 'read-only sessions have no Delete action');
    check(labels.some((l) => l.includes('Read-only')), 'read-only sessions surface their state');
    h.close();
  }

  // ── 15. workspace bind goes through core /api/projects/bind ───────────
  {
    const projects = [{ project_id: 'p1', name: 'Alpha' }];
    const h = makeHarness({ projects, sessions: [], coreMenu: true, dialogs: { prompt: Promise.resolve('/ws/new-place') } });
    await boot(h);
    h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-group-gear').click();
    const ws = [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('workspace'));
    ws.onclick({});
    await tick(20);
    const bind = h.posts.find((p) => p.url === '/api/projects/bind');
    check(bind, 'workspace dialog writes through core /api/projects/bind');
    checkEqual(bind.body.default_workspace, '/ws/new-place', 'bind payload uses core field name');
    h.close();
  }

  // ── 16. retained pager buttons act on the CURRENT rows ───────────────
  {
    const projects = [{ project_id: 'p1', name: 'Alpha' }];
    const mk = (n) => { const a = []; for (let i = 1; i <= n; i++) a.push(session('q' + String(i).padStart(2, '0'), { project_id: 'p1', last_message_at: 1000 - i })); return a; };
    const h = makeHarness({ projects, sessions: mk(6) });
    await boot(h);
    h.setData(undefined, mk(20));
    await h.refresh(); // Show more button is retained, label updated
    const counts = [];
    for (let i = 0; i < 3; i++) {
      h.groupBody('p1').querySelector('.pf-showmore').click();
      counts.push(h.groupBody('p1').querySelectorAll('.pf-row').length);
    }
    checkEqual(counts.join(','), '10,15,20', 'Show more pages through rows that arrived after the button was created');
    h.close();
  }

  // ── 17. keyboard focus never falls to <body> when a control vanishes ──
  {
    // p0 renders first, so "first control in the list" != p1's own header
    const projects = [{ project_id: 'p0', name: 'Zero' }, { project_id: 'p1', name: 'Alpha' }];
    const sessions = [session('z1', { project_id: 'p0' })];
    for (let i = 1; i <= 7; i++) sessions.push(session('k' + i, { project_id: 'p1', last_message_at: 1000 - i }));
    const h = makeHarness({ projects, sessions });
    await boot(h);
    const more = h.groupBody('p1').querySelector('.pf-showmore');
    more.focus();
    more.click(); // last page: the button disappears
    check(!more.isConnected, 'Show more is gone after the last page');
    checkEqual(h.w.document.activeElement, h.rowFor('k6').querySelector('.pf-row-open'),
      'focus lands on the first newly revealed chat, not <body>');
    const less = h.groupBody('p1').querySelector('.pf-showless');
    less.focus();
    less.click();
    checkEqual(h.w.document.activeElement, h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-group-toggle'),
      'Show less hands focus to the folder header');
    // a focused row that disappears on refresh falls back to its folder header
    h.rowFor('k2').querySelector('.pf-row-open').focus();
    h.setData(undefined, sessions.filter((x) => x.session_id !== 'k2'));
    await h.refresh();
    check(!h.rowFor('k2'), 'removed row is gone');
    checkEqual(h.w.document.activeElement, h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-group-toggle'),
      'focus on a removed row falls back to the folder header');
    h.close();
  }

  // ── 18. core menu actions return focus to the trigger first ───────────
  {
    const h = makeHarness({ projects: [{ project_id: 'p1', name: 'Alpha' }], sessions: [session('s1')], coreMenu: true });
    await boot(h);
    const trigger = h.rowFor('s1').querySelector('.pf-row-more');
    trigger.click();
    const menu = h.mountedMenus[0];
    const item = [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('Regenerate title'));
    item.focus();
    menu.remove(); // core's close removes the focused item
    let focusAtAction = null;
    const origFetch = h.w.fetch;
    h.w.fetch = async (path, opts) => { if (String(path).includes('/title/regenerate')) focusAtAction = h.w.document.activeElement; return origFetch(path, opts); };
    item.onclick({ preventDefault() {}, stopPropagation() {} });
    await tick(10);
    checkEqual(focusAtAction, trigger, 'a menu action runs with focus back on its trigger (never <body>)');
    h.close();
  }

  // ── 18b. one core menu at a time; same trigger toggles ───────────────
  {
    const h = makeHarness({ projects: [], sessions: [session('s1'), session('s2')], coreMenu: true });
    await boot(h);
    h.rowFor('s1').querySelector('.pf-row-more').click();
    h.rowFor('s2').querySelector('.pf-row-more').click();
    checkEqual(h.d.querySelectorAll('body > .session-action-menu').length, 1, 'opening another row menu retires the open one');
    h.rowFor('s2').querySelector('.pf-row-more').click();
    checkEqual(h.d.querySelectorAll('body > .session-action-menu').length, 0, 'the same trigger toggles its menu closed');
    h.close();
  }

  // ── 19. HERMES.md dialog keeps focus inside, then returns it ─────────
  {
    const projects = [{ project_id: 'p1', name: 'Alpha', default_workspace: '/ws/alpha' }];
    const sessions = [session('s1', { project_id: 'p1', workspace: '/ws/alpha' })];
    const h = makeHarness({ projects, sessions, coreMenu: true });
    await boot(h);
    let release;
    h.holdFile = new Promise((r) => { release = r; });
    const gear = h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-group-gear');
    gear.click();
    [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('Project instructions')).onclick({});
    await tick(5);
    const dlg = h.d.querySelector('.pf-dialog');
    check(dlg && dlg.contains(h.w.document.activeElement), 'while loading, focus is on an enabled control inside the dialog');
    release();
    h.holdFile = null;
    await tick(20);
    checkEqual(h.w.document.activeElement, dlg.querySelector('.pf-textarea'), 'after a successful read the editor has focus');
    [...dlg.querySelectorAll('.pf-btn')].find((b) => b.textContent === 'Save').click();
    await tick(20);
    check(!h.d.querySelector('.pf-dialog'), 'dialog closes after save');
    checkEqual(h.w.document.activeElement, gear, 'focus returns to the project gear');
    h.close();
  }
  {
    // a 404 that is NOT "file missing" (core refusal) is reported as such
    const projects = [{ project_id: 'p1', name: 'Alpha', default_workspace: '/ws/alpha' }];
    const sessions = [session('s1', { project_id: 'p1', workspace: '/ws/alpha' })];
    const h = makeHarness({ projects, sessions, coreMenu: true });
    h.mdRefused = true;
    await boot(h);
    h.d.querySelector('#pf-folders .pf-group[data-key="p1"] .pf-group-gear').click();
    [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('Project instructions')).onclick({});
    await tick(30);
    const txt = h.d.querySelector('.pf-dialog .pf-dialog-text').textContent;
    check(/Path traversal blocked/.test(txt) && !/No HERMES\.md/.test(txt), 'core refusals are not mislabeled as "no file yet"');
    checkEqual([...h.d.querySelectorAll('.pf-dialog .pf-btn')].find((b) => b.textContent === 'Save').disabled, true, 'Save stays disabled on any failed read');
    h.close();
  }

  // ── 19b. saving keeps focus in the dialog; stale saves never close a newer one ──
  {
    const projects = [{ project_id: 'p1', name: 'Alpha', default_workspace: '/ws/alpha' },
      { project_id: 'p2', name: 'Beta', default_workspace: '/ws/beta' }];
    const sessions = [session('s1', { project_id: 'p1', workspace: '/ws/alpha' }), session('s2', { project_id: 'p2', workspace: '/ws/beta' })];
    const h = makeHarness({ projects, sessions, coreMenu: true });
    await boot(h);
    const openMd = async (pid) => {
      h.d.querySelector(`#pf-folders .pf-group[data-key="${pid}"] .pf-group-gear`).click();
      [...h.mountedMenus[h.mountedMenus.length - 1].querySelectorAll('button')].find((b) => b.textContent.includes('Project instructions')).onclick({});
      await tick(20);
      return h.d.querySelector('.pf-dialog');
    };
    const dlgA = await openMd('p1');
    let releaseA;
    h.holdPost = new Promise((r) => { releaseA = r; });
    const saveA = [...dlgA.querySelectorAll('.pf-btn')].find((b) => b.textContent === 'Save');
    saveA.focus();
    saveA.click();
    await tick(5);
    checkEqual(h.w.document.activeElement, saveA, 'a pending save keeps focus on Save (never <body>)');
    checkEqual(saveA.getAttribute('aria-disabled'), 'true', 'Save is marked busy while the request runs');
    check(dlgA.querySelector('.pf-textarea').readOnly, 'the editor is frozen while saving');
    dlgA.querySelector('.pf-dialog-x').click(); // close A while its save is in flight
    const dlgB = await openMd('p2');
    dlgB.querySelector('.pf-textarea').value = '# unsaved B';
    h.holdPost = null;
    releaseA();
    await tick(20);
    check(dlgB.isConnected, "a late save from an older dialog does not close the newer one");
    checkEqual(dlgB.querySelector('.pf-textarea').value, '# unsaved B', "the newer dialog keeps its unsaved text");
    h.close();
  }

  // ── 19c. core menu teardown re-homes focus (scroll close, rebuilt trigger) ──
  {
    const projects = [{ project_id: 'p1', name: 'Alpha' }];
    const sessions = [session('s1', { project_id: null }), session('s2', { project_id: null })];
    const h = makeHarness({ projects, sessions, coreMenu: true });
    await boot(h);
    const trig = h.rowFor('s1').querySelector('.pf-row-more');
    trig.click();
    const m1 = h.mountedMenus[h.mountedMenus.length - 1];
    m1.querySelector('button').focus();
    m1.remove(); // e.g. core closing it on a scroll outside its own list, no restore
    await tick(0);
    checkEqual(h.w.document.activeElement, trig, 'a non-restoring menu close returns focus to the trigger');
    // the trigger is rebuilt (row moved to another folder) while the menu is open
    trig.click();
    const m2 = h.mountedMenus[h.mountedMenus.length - 1];
    m2.querySelector('button').focus();
    h.setData(undefined, [session('s1', { project_id: 'p1' }), session('s2', { project_id: null })]);
    await h.refresh();
    check(!trig.isConnected, 'the original trigger was replaced by the reconcile');
    m2.remove();
    await tick(0);
    checkEqual(h.w.document.activeElement, h.rowFor('s1').querySelector('.pf-row-more'), 'focus re-homes to the rebuilt trigger (same data-pfk)');
    h.close();
  }

  // ── 19d. moving the open chat keeps core's record in step; reuse fails safe ──
  {
    const projects = [{ project_id: 'p1', name: 'Alpha' }];
    const h = makeHarness({ projects, sessions: [session('s1', { project_id: 'p1' })], coreMenu: true });
    h.w.S = { session: { session_id: 's1', project_id: 'p1' }, activeProfile: 'default' };
    await boot(h);
    h.rowFor('s1').querySelector('.pf-row-more').click();
    [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('Unassigned')).onclick({});
    await tick(20);
    checkEqual(h.w.S.session.project_id, null, 'moving the open chat updates S.session.project_id');
    // stale core record says unassigned, fresh list row says p1 -> do not reuse
    h.w._currentSessionIsReusableEmptyChat = () => true;
    h.w.S = { session: { session_id: 'e1', project_id: null }, activeProfile: 'default' };
    h.setData(undefined, [session('s1'), session('e1', { project_id: 'p1' })]);
    await h.refresh();
    h.d.querySelector('#pf-folders .pf-group[data-key="unassigned"] .pf-group-plus').click();
    await tick(10);
    checkEqual(h.newSessionCalls.length, 1, 'reuse is refused when the list row puts the empty chat in a project');
    h.close();
  }

  // ── 20. Use project workspace: open chat via core switchToWorkspace ──
  {
    const projects = [{ project_id: 'p1', name: 'Alpha', default_workspace: '/ws/alpha' }];
    const sessions = [session('s1', { project_id: 'p1', workspace: '/ws/old' }), session('s2', { project_id: 'p1', workspace: '/ws/old' })];
    const h = makeHarness({ projects, sessions, coreMenu: true, dialogs: { confirm: Promise.resolve(true) } });
    h.w.S = { session: { session_id: 's1', workspace: '/ws/old' }, activeProfile: 'default' };
    await boot(h);
    h.rowFor('s1').querySelector('.pf-row-more').click();
    [...h.mountedMenus[0].querySelectorAll('button')].find((b) => b.textContent.includes('Use project workspace')).onclick({});
    await tick(20);
    checkEqual(h.workspaceSwitches.join(','), '/ws/alpha', 'the open chat switches through core switchToWorkspace (composer + tree follow)');
    check(!h.posts.some((p) => p.url === '/api/session/update'), 'no bare /api/session/update for the open chat');
    h.rowFor('s2').querySelector('.pf-row-more').click();
    [...h.mountedMenus[1].querySelectorAll('button')].find((b) => b.textContent.includes('Use project workspace')).onclick({});
    await tick(20);
    const upd = h.posts.find((p) => p.url === '/api/session/update');
    check(upd && upd.body.session_id === 's2' && upd.body.workspace === '/ws/alpha', 'a background chat is updated through /api/session/update');
    check(h.toasts.some((t) => /Workspace set to \/ws\/alpha/.test(t)), 'success toast names the workspace');
    h.close();
  }

  // ── 21. no false empty state before the first data round ─────────────
  {
    const h = makeHarness({ projects: [], sessions: [session('s1')] });
    h.failLists = true;
    await tick(30);
    check(!h.d.querySelector('#pf-folders .pf-group'), 'no "0 chats" groups are painted before data loads');
    check(/Could not load conversations/.test(h.d.getElementById('pf-scroll').textContent), 'a failed first load says so');
    h.failLists = false;
    await h.refresh();
    check(h.rowFor('s1'), 'rows appear once data loads');
    const note = h.d.querySelector('#pf-scroll .pf-empty');
    check(!note || note.style.display === 'none', 'the failure note is hidden after a good round');
    h.close();
  }

  console.log(`project-folders behavior tests passed (${checks} checks)`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
