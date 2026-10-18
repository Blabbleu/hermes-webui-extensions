/* Hermes WebUI extension: Project Folders
 *
 * Turns the existing Projects (project_id on sessions) into a collapsible
 * folder sidebar with per-project "new chat" and project context
 * (workspace + HERMES.md) management.
 *
 * Design constraints:
 *  - additive DOM only: one container (#pf-folders) inside #panelChat; core
 *    session list is hidden via CSS class, never mutated;
 *  - core globals are used where available (loadSession/newSession/showToast)
 *    and feature-checked; missing core hooks degrade to URL navigation;
 *  - all data comes from the stock WebUI APIs (/api/projects, /api/sessions,
 *    /api/session/new|move|update|rename|archive|delete, /api/projects/*);
 *  - project->workspace binding + HERMES.md live on the extension sidecar
 *    (server-side, token-validated); cosmetic state lives in browser storage;
 *  - failures never break the WebUI: everything is guarded, and an
 *    incompatibility flips the extension into passive mode.
 */
(() => {
  'use strict';
  if (window.__PF_INJECTED__) return;
  window.__PF_INJECTED__ = true;

  const EXT_ID = 'project-folders';
  const PAGE_SIZE = 5; // rows shown per expanded group before "Show more"
  const LS = {
    mode: 'hermes-pf-mode',
    collapse: 'hermes-pf-collapse',
  };
  const DND_MIME = 'application/x-hermes-pf';

  const state = {
    ready: false,
    compatible: false,
    compatReason: '',
    mode: 'folders',
    projects: [],
    sessions: [],
    bindings: {},
    defaultWorkspace: '',
    collapsed: {},
    visibleCounts: {}, // per-group pagination window (display-only, not persisted)
    search: '',
    profile: 'default',
    lastHash: '',
    sidecarOk: null, // null = unknown, true/false
  };

  let pfRoot = null;
  let scrollEl = null;
  let refreshTimer = 0;
  let refreshInFlight = false;
  let pollTimer = 0;
  let timeTimer = 0;
  let activeTimer = 0;
  let lastActiveSid = null;
  let sse = null;
  let lastProfile = '';

  /* ── tiny utilities ─────────────────────────────────────────────────── */

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (_) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }
  function lsGetObj(key, fallback) {
    const v = lsGet(key, null);
    if (!v) return fallback;
    try {
      const p = JSON.parse(v);
      return (p && typeof p === 'object') ? p : fallback;
    } catch (_) { return fallback; }
  }
  function lsSetObj(key, obj) { lsSet(key, JSON.stringify(obj)); }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function esc(s) { return String(s == null ? '' : s); }

  function relTime(ts) {
    if (!ts) return '';
    const d = Date.now() / 1000 - Number(ts);
    if (!isFinite(d) || d < 0) return '';
    if (d < 60) return 'now';
    if (d < 3600) return Math.floor(d / 60) + 'm';
    if (d < 86400) return Math.floor(d / 3600) + 'h';
    if (d < 7 * 86400) return Math.floor(d / 86400) + 'd';
    const dt = new Date(Number(ts) * 1000);
    const y = dt.getFullYear() !== new Date().getFullYear() ? dt.getFullYear() + ' ' : '';
    return y + (dt.getMonth() + 1) + '/' + dt.getDate();
  }

  function debounce(fn, ms) {
    let t = 0;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  function toast(msg, ms) {
    try { if (typeof window.showToast === 'function') { window.showToast(msg, ms); return; } } catch (_) {}
    console.warn('[project-folders]', msg);
  }

  function activeProfile() {
    try {
      const p = (typeof S !== 'undefined' && S && S.activeProfile) ? S.activeProfile : null;
      return p || 'default';
    } catch (_) { return 'default'; }
  }

  /* ── storage handle (extension-owned settings, with fallback) ───────── */

  let extHandle = null;
  function initStorage() {
    try {
      const h = window.hermesExt && typeof window.hermesExt.register === 'function'
        ? window.hermesExt.register(EXT_ID) : null;
      if (h) extHandle = h;
    } catch (_) {}
    // mode: prefer extension settings, fall back to localStorage
    let mode = 'folders';
    try {
      if (extHandle && extHandle.settings && typeof extHandle.settings.get === 'function') {
        const v = extHandle.settings.get('mode');
        if (v === 'classic' || v === 'folders') mode = v;
      }
    } catch (_) {}
    if (mode === 'folders') mode = lsGet(LS.mode, 'folders') === 'classic' ? 'classic' : 'folders';
    state.mode = mode === 'classic' ? 'classic' : 'folders';
  }
  function setMode(mode) {
    state.mode = mode === 'classic' ? 'classic' : 'folders';
    lsSet(LS.mode, state.mode);
    try {
      if (extHandle && extHandle.settings && typeof extHandle.settings.set === 'function') {
        extHandle.settings.set('mode', state.mode);
      }
    } catch (_) {}
    applyMode();
  }

  /* ── API ────────────────────────────────────────────────────────────── */

  async function pfFetch(path, opts) {
    const o = Object.assign({ credentials: 'same-origin' }, opts || {});
    const r = await fetch(path, o);
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) {}
      const e = new Error(msg);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }
  const pfApiGet = (path) => pfFetch(path, { method: 'GET' });
  const pfApiPost = (path, body) => pfFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  /* ── sidecar ────────────────────────────────────────────────────────── */

  let sidecarNoticeShown = false;
  function sidecarUnavailableNotice(status) {
    state.sidecarOk = false;
    if (sidecarNoticeShown) return;
    sidecarNoticeShown = true;
    const hint = status === 403
      ? 'Project Folders: workspace features are paused — enable WebUI authentication (Settings → Security) to use project workspaces.'
      : 'Project Folders: sidecar is unavailable right now — workspace features are paused.';
    toast(hint, 8000);
  }
  async function sidecar(path, opts) {
    const o = Object.assign({ credentials: 'same-origin' }, opts || {});
    const r = await fetch('/api/extensions/' + EXT_ID + '/sidecar' + path, o);
    if (!r.ok) {
      let msg = 'sidecar HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) {}
      if (r.status === 403 || r.status === 503) sidecarUnavailableNotice(r.status);
      const e = new Error(msg);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }
  const sidecarGet = (path) => sidecar(path, { method: 'GET' });
  const sidecarPost = (path, body) => sidecar(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const sidecarPut = (path, body) => sidecar(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  /* ── data loading ───────────────────────────────────────────────────── */

  async function loadProjects() {
    const d = await pfApiGet('/api/projects');
    const arr = Array.isArray(d && d.projects) ? d.projects : [];
    state.projects = arr.filter(p => p && typeof p.project_id === 'string' && typeof p.name === 'string');
  }
  async function loadSessions() {
    const d = await pfApiGet('/api/sessions');
    const arr = Array.isArray(d && d.sessions) ? d.sessions : [];
    state.sessions = arr.filter(s => s && typeof s.session_id === 'string');
  }
  async function loadBindings() {
    const d = await sidecarGet('/v1/state');
    const b = d && typeof d.bindings === 'object' && d.bindings ? d.bindings : {};
    state.bindings = {};
    for (const pid of Object.keys(b)) {
      const ws = b[pid] && typeof b[pid].workspace === 'string' ? b[pid].workspace : null;
      if (ws) state.bindings[pid] = { workspace: ws };
    }
    state.defaultWorkspace = typeof d.default_workspace === 'string' ? d.default_workspace : '';
    state.sidecarOk = true;
  }
  function markSidecarDown() {
    state.sidecarOk = false;
  }

  function snapshotHash() {
    let h = 0x811c9dc5;
    const mix = (s) => {
      s = String(s);
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    };
    mix('p');
    for (const p of state.projects) mix(p.project_id + '|' + p.name + '|' + (p.color || ''));
    mix('s');
    for (const s of state.sessions) {
      mix(s.session_id + '|' + (s.title || '') + '|' + Math.round(Number(s.last_message_at || s.updated_at || 0)) +
        '|' + (s.project_id || '') + '|' + (s.is_streaming || s.active_stream_id ? 1 : 0) +
        '|' + (s.attention || '') + '|' + (s.pinned ? 1 : 0) + '|' + (s.archived ? 1 : 0));
    }
    mix('b');
    for (const pid of Object.keys(state.bindings).sort()) mix(pid + '=' + state.bindings[pid].workspace);
    mix('m' + state.mode + '|' + (state.search || '') + '|' + (state.profile || ''));
    return String(h >>> 0);
  }

  function scheduleRefresh(opts) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void refresh(opts || {}); }, (opts && opts.delayMs) || 250);
  }

  async function refresh(opts) {
    if (!state.ready || refreshInFlight) return;
    refreshInFlight = true;
    try {
      const profile = activeProfile();
      const profileChanged = profile !== lastProfile;
      lastProfile = profile;
      state.profile = profile;

      const results = await Promise.allSettled([loadProjects(), loadSessions()]);
      if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') {
        // network hiccup — keep previous data, retry shortly
        scheduleRefresh({ delayMs: 8000 });
        return;
      }
      try {
        await loadBindings();
      } catch (_) {
        markSidecarDown();
      }
      // profile change forces a repaint even if content hash is identical
      const hash = snapshotHash();
      state.lastHash = hash;
      render();
    } catch (err) {
      console.warn('[project-folders] refresh failed', err);
    } finally {
      refreshInFlight = false;
    }
  }

  /* ── compatibility ──────────────────────────────────────────────────── */

  function checkCompatibility() {
    const missing = [];
    if (!document.getElementById('sessionList')) missing.push('#sessionList');
    if (!document.getElementById('panelChat')) missing.push('#panelChat');
    if (typeof window.loadSession !== 'function') missing.push('loadSession()');
    if (!missing.length) {
      state.compatible = true;
    } else {
      state.compatible = false;
      state.compatReason = missing.join(', ');
    }
  }

  /* ── DOM: skeleton ──────────────────────────────────────────────────── */

  function buildDom() {
    if (document.getElementById('pf-folders')) return;
    pfRoot = el('div', 'pf-root', null);
    pfRoot.id = 'pf-folders';

    const bar = el('div', 'pf-modebar');
    const label = el('span', 'pf-modebar-label', 'Sidebar');
    const btnFolders = el('button', 'pf-modebtn', 'Folders');
    const btnClassic = el('button', 'pf-modebtn', 'Classic');
    btnFolders.type = 'button';
    btnClassic.type = 'button';
    btnFolders.onclick = () => setMode('folders');
    btnClassic.onclick = () => setMode('classic');
    bar.appendChild(label);
    const seg = el('span', 'pf-mode-seg');
    seg.appendChild(btnFolders);
    seg.appendChild(btnClassic);
    bar.appendChild(seg);
    pfRoot.appendChild(bar);

    scrollEl = el('div', 'pf-scroll');
    scrollEl.id = 'pf-scroll';
    pfRoot.appendChild(scrollEl);

    const panel = document.getElementById('panelChat');
    const list = document.getElementById('sessionList');
    const search = panel ? panel.querySelector('.session-search') : null;
    const anchor = search || list || (panel ? panel.firstChild : null);
    if (panel) {
      if (anchor && anchor.parentNode === panel) panel.insertBefore(pfRoot, anchor);
      else panel.appendChild(pfRoot);
    } else {
      document.body.appendChild(pfRoot);
    }

    // search mirroring (core input, our list)
    const input = document.getElementById('sessionSearch');
    if (input) {
      const onInput = debounce(() => {
        state.search = (input.value || '').trim();
        render();
      }, 150);
      input.addEventListener('input', onInput);
      state.search = (input.value || '').trim();
    }

    // events
    try {
      sse = new EventSource('/api/sessions/events');
      sse.addEventListener('sessions_changed', (ev) => {
        try {
          const payload = ev && typeof ev.data === 'string' ? JSON.parse(ev.data) : {};
          const p = payload && typeof payload.profile === 'string' ? payload.profile : '';
          if (p && p !== activeProfile()) return;
          scheduleRefresh({ delayMs: 300 });
        } catch (_) {
          scheduleRefresh({ delayMs: 500 });
        }
      });
      sse.onerror = () => { /* core reconnects itself; we rely on polling */ };
    } catch (_) { sse = null; }

    pollTimer = setInterval(() => {
      if (document.hidden) return;
      void refresh({});
    }, 30000);
    timeTimer = setInterval(() => {
      if (document.hidden || !scrollEl) return;
      updateTimesInPlace();
    }, 60000);
    // The open chat may come from anywhere (deep link, search, restore). If it
    // changes, re-render so its row is guaranteed visible in its folder even
    // when it sorts below the 5-row window.
    activeTimer = setInterval(() => {
      if (document.hidden) return;
      let cur = null;
      try { cur = (typeof S !== 'undefined' && S.session && S.session.session_id) || null; } catch (_) { cur = null; }
      if (cur !== lastActiveSid) {
        lastActiveSid = cur;
        if (state.mode === 'folders' && state.ready) render();
      }
    }, 1500);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void refresh({});
    });
  }

  function applyMode() {
    try { document.body.classList.toggle('pf-mode-folders', state.mode === 'folders'); } catch (_) {}
    if (state.mode === 'folders') {
      render();
    }
  }

  /* ── DOM: render ────────────────────────────────────────────────────── */

  function visibleSessions() {
    const q = state.search.toLowerCase();
    const out = [];
    for (const s of state.sessions) {
      if (s.archived) continue;
      if (q) {
        const t = String(s.title || '').toLowerCase();
        if (t.indexOf(q) === -1) continue;
      }
      out.push(s);
    }
    return out;
  }

  function sortRows(rows) {
    const ts = (s) => Number(s.last_message_at || s.updated_at || s.created_at || 0);
    return rows.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const d = ts(b) - ts(a);
      if (d !== 0) return d;
      return String(a.session_id).localeCompare(String(b.session_id));
    });
  }

  function openSession(sid) {
    try {
      if (typeof window.loadSession === 'function') { window.loadSession(sid); return; }
    } catch (_) {}
    try { location.href = '/session/' + encodeURIComponent(sid); } catch (_) {}
  }

  function makeRow(s, project) {
    const row = el('div', 'pf-row');
    row.dataset.sid = s.session_id;
    if (s.is_streaming || s.active_stream_id) row.classList.add('pf-streaming');
    if (s.attention) row.classList.add('pf-attention');
    if (s.pinned) row.classList.add('pf-pinned');
    if (s.read_only) row.classList.add('pf-readonly');

    const title = el('span', 'pf-row-title', s.title || 'Untitled');
    if (s.is_streaming || s.active_stream_id) {
      const dot = el('span', 'pf-dot-live', '');
      dot.title = 'streaming';
      title.appendChild(dot);
    } else if (s.attention) {
      const dot = el('span', 'pf-dot-att', '');
      dot.title = String(s.attention);
      title.appendChild(dot);
    }
    row.appendChild(title);
    const time = el('span', 'pf-row-time');
    time.dataset.ts = String(s.last_message_at || s.updated_at || s.created_at || '');
    time.textContent = relTime(Number(s.last_message_at || s.updated_at || s.created_at || 0));
    row.appendChild(time);

    const more = el('button', 'pf-row-more', '⋯');
    more.type = 'button';
    more.title = 'Actions';
    more.onclick = (e) => {
      e.stopPropagation();
      openMenu(rowMenuItems(s, project), more, { x: -14 });
    };
    row.appendChild(more);

    row.onclick = () => openSession(s.session_id);
    row.ondblclick = (e) => e.stopPropagation();

    // drag & drop (desktop only)
    if (finePointer()) {
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', (e) => {
        try {
          e.dataTransfer.setData(DND_MIME, s.session_id);
          e.dataTransfer.setData('text/plain', s.title || s.session_id);
          e.dataTransfer.effectAllowed = 'move';
          row.classList.add('pf-dragging');
        } catch (_) {}
      });
      row.addEventListener('dragend', () => row.classList.remove('pf-dragging'));
    }
    return row;
  }

  function finePointer() {
    try { return window.matchMedia && window.matchMedia('(pointer: fine)').matches; }
    catch (_) { return false; }
  }

  function makeNewChatRow(projectId) {
    const row = el('div', 'pf-row pf-newchat', null);
    const t = el('span', 'pf-row-title pf-newchat-label', '+ New chat');
    row.appendChild(t);
    row.onclick = (e) => {
      e.stopPropagation();
      void newChatInProject(projectId);
    };
    return row;
  }

  function makeGroupHeader(project, count, isUnassigned) {
    const h = el('div', 'pf-group-header');
    h.dataset.projectId = isUnassigned ? '' : (project ? project.project_id : '');
    const chev = el('span', 'pf-chevron', state.collapsed[h.dataset.projectId || 'unassigned'] ? '▸' : '▾');
    h.appendChild(chev);
    if (!isUnassigned && project && project.color) {
      const dot = el('span', 'pf-dot');
      dot.style.background = project.color;
      h.appendChild(dot);
    }
    const name = el('span', 'pf-group-name', isUnassigned ? 'Unassigned' : (project.name || 'Project'));
    h.appendChild(name);
    const cnt = el('span', 'pf-count', String(count));
    h.appendChild(cnt);

    const actions = el('span', 'pf-group-actions');
    if (!isUnassigned) {
      const plus = el('button', 'pf-icon-btn', '+');
      plus.type = 'button';
      plus.title = 'New chat in ' + (project.name || 'project');
      plus.onclick = (e) => { e.stopPropagation(); void newChatInProject(project.project_id); };
      actions.appendChild(plus);

      const ws = state.bindings[project.project_id];
      const gear = el('button', 'pf-icon-btn', '⚙');
      gear.type = 'button';
      gear.title = ws ? 'Project settings (workspace: ' + ws.workspace + ')' : 'Project settings';
      gear.onclick = (e) => { e.stopPropagation(); openMenu(projectMenuItems(project), gear); };
      actions.appendChild(gear);
    }
    h.appendChild(actions);

    h.onclick = () => toggleCollapse(h.dataset.projectId || 'unassigned');
    // drop target
    if (finePointer()) {
      h.addEventListener('dragover', (e) => {
        if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, DND_MIME) !== -1) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          h.classList.add('pf-droptarget');
        }
      });
      h.addEventListener('dragleave', () => h.classList.remove('pf-droptarget'));
      h.addEventListener('drop', (e) => {
        h.classList.remove('pf-droptarget');
        const sid = e.dataTransfer.getData(DND_MIME);
        if (!sid) return;
        e.preventDefault();
        void moveSession(sid, isUnassigned ? null : (project ? project.project_id : null));
      });
    }
    return h;
  }

  function toggleCollapse(key) {
    state.collapsed[key] = !state.collapsed[key];
    lsSetObj(LS.collapse, state.collapsed);
    if (!state.collapsed[key]) state.visibleCounts[key] = PAGE_SIZE; // re-expand → compact 5
    render();
  }

  function render() {
    if (!pfRoot || state.mode !== 'folders') return;
    if (!state.compatible) { renderIncompatible(); return; }
    scrollEl.innerHTML = '';

    const sessions = visibleSessions();
    const byProject = {};
    const unassigned = [];
    for (const s of sessions) {
      if (s.project_id) {
        (byProject[s.project_id] = byProject[s.project_id] || []).push(s);
      } else {
        unassigned.push(s);
      }
    }

    let anyGroup = false;
    for (const project of state.projects) {
      const rows = sortRows(byProject[project.project_id] || []);
      scrollEl.appendChild(renderGroup(project, rows, false));
      anyGroup = true;
    }
    // projects that have no sessions at all still appear (empty folder)
    if (unassigned.length) {
      scrollEl.appendChild(renderGroup(null, sortRows(unassigned), true));
      anyGroup = true;
    }
    if (!anyGroup) {
      const empty = el('div', 'pf-empty', 'No conversations yet. Create a project or start a chat.');
      scrollEl.appendChild(empty);
    }
  }

  function groupVisibleCount(key, rows) {
    let n = Number(state.visibleCounts[key]) || PAGE_SIZE;
    if (n < PAGE_SIZE) n = PAGE_SIZE;
    // CRITICAL: the currently open chat stays visible even when it sorts
    // below the first page — extend the window to include it.
    let activeId = null;
    try { activeId = (typeof S !== 'undefined' && S.session && S.session.session_id) || null; } catch (_) { activeId = null; }
    if (activeId) {
      const idx = rows.findIndex((r) => r.session_id === activeId);
      if (idx >= n) n = idx + 1;
    }
    if (n > rows.length) n = rows.length;
    return n;
  }

  function renderGroup(project, rows, isUnassigned) {
    const key = isUnassigned ? 'unassigned' : project.project_id;
    const g = el('div', 'pf-group');
    g.appendChild(makeGroupHeader(project, rows.length, isUnassigned));
    if (!state.collapsed[key]) {
      const body = el('div', 'pf-group-body');
      const n = groupVisibleCount(key, rows);
      for (let i = 0; i < n; i++) body.appendChild(makeRow(rows[i], project));
      const remaining = rows.length - n;
      if (remaining > 0) {
        const more = el('button', 'pf-showmore', 'Show ' + Math.min(PAGE_SIZE, remaining) + ' more · ' + remaining + ' remaining');
        more.type = 'button';
        more.onclick = () => {
          state.visibleCounts[key] = groupVisibleCount(key, rows) + PAGE_SIZE;
          render();
        };
        body.appendChild(more);
      }
      if (n > PAGE_SIZE) {
        const less = el('button', 'pf-showless', 'Show less');
        less.type = 'button';
        less.onclick = () => {
          state.visibleCounts[key] = PAGE_SIZE;
          render();
        };
        body.appendChild(less);
      }
      body.appendChild(makeNewChatRow(isUnassigned ? null : project.project_id));
      g.appendChild(body);
    }
    return g;
  }

  function renderIncompatible() {
    scrollEl.innerHTML = '';
    const box = el('div', 'pf-empty pf-incompatible');
    box.appendChild(el('div', null, 'Project Folders extension is inactive: the WebUI version is missing expected hooks (' + state.compatReason + ').'));
    box.appendChild(el('div', 'pf-empty-hint', 'Switch to Classic sidebar mode to continue using the standard list. The extension will retry after a WebUI update/reload.'));
    const back = el('button', 'pf-modebtn pf-incompat-back', 'Switch to Classic');
    back.type = 'button';
    back.onclick = () => setMode('classic');
    box.appendChild(back);
    scrollEl.appendChild(box);
  }

  function updateTimesInPlace() {
    if (!scrollEl) return;
    const nodes = scrollEl.querySelectorAll('.pf-row-time[data-ts]');
    for (const n of nodes) {
      const ts = Number(n.dataset.ts || 0);
      n.textContent = relTime(ts);
    }
  }

  /* ── actions ────────────────────────────────────────────────────────── */

  async function newChatInProject(projectId) {
    try {
      const body = { profile: activeProfile() };
      const binding = projectId ? state.bindings[projectId] : null;
      if (projectId) body.project_id = projectId;
      if (binding && binding.workspace) body.workspace = binding.workspace;
      // Use the core quick-create path when it can do the job (no explicit
      // workspace needed); otherwise hit the stock session API directly with
      // workspace + project_id atomically.
      const useCore = !binding && typeof window.newSession === 'function';
      if (useCore) {
        const opts = {};
        if (projectId) opts.project_id = projectId;
        await window.newSession(true, opts);
      } else {
        const data = await pfApiPost('/api/session/new', body);
        const sid = data && data.session && data.session.session_id;
        if (!sid) throw new Error('session created without id');
        await openSession(sid);
      }
      scheduleRefresh({ delayMs: 100 });
    } catch (err) {
      toast('New chat failed: ' + (err && err.message || err), 4000);
    }
  }

  async function moveSession(sid, projectId) {
    try {
      await pfApiPost('/api/session/move', { session_id: sid, project_id: projectId || null });
      toast(projectId ? 'Moved to project' : 'Removed from project');
      scheduleRefresh({ delayMs: 100 });
    } catch (err) {
      toast('Move failed: ' + (err && err.message || err), 4000);
    }
  }

  async function useProjectWorkspace(sid, workspace) {
    try {
      await pfApiPost('/api/session/update', { session_id: sid, workspace: workspace });
      toast('Session workspace set to project workspace');
      scheduleRefresh({ delayMs: 100 });
    } catch (err) {
      toast('Workspace update failed: ' + (err && err.message || err), 4000);
    }
  }

  // Ask the local model for a title that matches what the conversation is
  // actually about, then apply it via the stock rename API (same semantics as
  // the core rename: manual title, protected from adaptive refresh).
  async function regenerateTitle(s) {
    const row = scrollEl && scrollEl.querySelector('.pf-row[data-sid="' + CSS.escape(s.session_id) + '"] .pf-row-title');
    const prevText = row ? row.textContent : null;
    if (row) row.textContent = 'Renaming…';
    try {
      const data = await pfApiGet('/api/session?session_id=' + encodeURIComponent(s.session_id) + '&messages=1&resolve_model=0');
      const raw = (data && data.session && data.session.messages) || [];
      if (!raw.length) throw new Error('no messages in session');
      // Pre-trim client-side: long chats serialize to >1MB of JSON, which the
      // sidecar body cap rejects (and wastes LLM context anyway). Keep only
      // user/assistant text, cap each message, then keep the most recent tail.
      let budget = 9000;
      const trimmed = [];
      for (let i = raw.length - 1; i >= 0 && budget > 0; i--) {
        const m = raw[i];
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        let c = m.content;
        if (Array.isArray(c)) c = c.filter(p => p && p.type === 'text').map(p => p.text || '').join(' ');
        c = String(c || '').replace(/\s+/g, ' ').trim();
        if (!c) continue;
        if (c.length > 400) c = c.slice(0, 400) + '…';
        budget -= c.length;
        trimmed.unshift({ role: m.role, content: c });
      }
      if (!trimmed.length) throw new Error('no text messages to summarize');
      const res = await sidecarPost('/v1/generate-title', { messages: trimmed });
      if (!res || !res.title) throw new Error((res && res.error) || 'no title returned');
      await pfApiPost('/api/session/rename', { session_id: s.session_id, title: res.title });
      toast('Title: ' + res.title);
      scheduleRefresh({ delayMs: 100 });
    } catch (err) {
      if (row && prevText !== null) row.textContent = prevText;
      toast('Regenerate title failed: ' + (err && err.message || err), 5000);
    }
  }

  /* ── menus ──────────────────────────────────────────────────────────── */

  let menuListeners = null; // { onDoc, onKey } of the currently open menu

  function closeMenu() {
    if (menuListeners) {
      document.removeEventListener('mousedown', menuListeners.onDoc, true);
      document.removeEventListener('keydown', menuListeners.onKey, true);
      menuListeners = null;
    }
    const m = document.querySelector('.pf-menu');
    if (m) m.remove();
  }
  function openMenu(items, anchor, opts) {
    closeMenu();
    const menu = el('div', 'pf-menu');
    menu.style.zIndex = '100000';
    for (const it of items) {
      if (it === null) {
        menu.appendChild(el('div', 'pf-menu-sep'));
        continue;
      }
      if (!it.action) {
        menu.appendChild(el('div', 'pf-menu-label', it.label));
        continue;
      }
      const b = el('button', 'pf-menu-item' + (it.danger ? ' pf-menu-danger' : ''), it.label);
      b.type = 'button';
      if (it.disabled) b.disabled = true;
      b.onclick = () => { closeMenu(); it.action && it.action(); };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 220;
    let x = r.right + ((opts && opts.x) || 4);
    if (x + mw > window.innerWidth - 8) x = r.left - mw - 4;
    let y = r.top;
    const mh = menu.offsetHeight || 100;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top = y + 'px';
    // Central listener registry: closeMenu() always removes the current menu's
    // document listeners, so a closed menu can never close a newly opened one.
    const onDoc = (e) => {
      if (!menu.contains(e.target)) closeMenu();
    };
    const onKey = (e) => { if (e.key === 'Escape') onDoc({ target: document.body }); };
    menuListeners = { onDoc, onKey };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }

  function rowMenuItems(s, project) {
    const items = [];
    const projects = state.projects;
    if (!s.read_only) {
      if (projects.length) {
        items.push({ label: 'Move to…' });
        for (const p of projects) {
          const cur = s.project_id === p.project_id;
          items.push({
            label: (cur ? '✓ ' : '    ') + p.name,
            disabled: cur,
            action: () => void moveSession(s.session_id, p.project_id),
          });
        }
        if (s.project_id) {
          items.push({
            label: '    No project (Unassigned)',
            action: () => void moveSession(s.session_id, null),
          });
        }
      }
      items.push(null);
      const binding = project ? state.bindings[project.project_id] : null;
      if (binding && s.workspace && s.workspace !== binding.workspace) {
        items.push({
          label: 'Use project workspace',
          action: () => {
            askConfirm(
              'Use project workspace?',
              'This changes the working directory of this session to ' + binding.workspace +
              '. Tool calls (terminal, file tools) will run there from the next turn.',
              () => void useProjectWorkspace(s.session_id, binding.workspace),
            );
          },
        });
      }
      items.push({
        label: 'Rename…',
        action: () => askPrompt('Rename conversation', s.title || '', (v) => {
          if (!v) return;
          void pfApiPost('/api/session/rename', { session_id: s.session_id, title: v })
            .then(() => scheduleRefresh({ delayMs: 100 }))
            .catch((e) => toast('Rename failed: ' + e.message, 4000));
        }),
      });
      items.push({
        label: 'Regenerate title from context',
        action: () => void regenerateTitle(s),
      });
      items.push({
        label: s.archived ? 'Unarchive' : 'Archive',
        action: () => {
          void pfApiPost('/api/session/archive', { session_id: s.session_id, archived: !s.archived })
            .then(() => scheduleRefresh({ delayMs: 100 }))
            .catch((e) => toast('Archive failed: ' + e.message, 4000));
        },
      });
      items.push({
        label: 'Delete…',
        danger: true,
        action: () => askConfirm('Delete this conversation?', 'This cannot be undone.', () => {
          void pfApiPost('/api/session/delete', { session_id: s.session_id })
            .then(() => scheduleRefresh({ delayMs: 100 }))
            .catch((e) => toast('Delete failed: ' + e.message, 4000));
        }),
      });
    } else {
      items.push({ label: 'Read-only session (imported)', disabled: true });
    }
    return items;
  }

  function projectMenuItems(project) {
    const binding = state.bindings[project.project_id];
    const items = [
      { label: 'New chat here', action: () => void newChatInProject(project.project_id) },
      null,
    ];
    if (state.sidecarOk === false) {
      items.push({
        label: '⚠ WebUI auth required for workspace features',
        disabled: true,
      }, null);
    }
    items.push(
      {
        label: binding ? 'Change workspace…' : 'Set workspace…',
        action: () => openWorkspaceDialog(project),
      },
      {
        label: 'Project instructions (HERMES.md)…',
        disabled: !binding,
        action: () => openHermesMdDialog(project),
      },
      null,
      {
        label: 'Rename project…',
        action: () => askPrompt('Rename project', project.name, (v) => {
          if (!v || v === project.name) return;
          void pfApiPost('/api/projects/rename', { project_id: project.project_id, name: v })
            .then(() => scheduleRefresh({ delayMs: 100 }))
            .catch((e) => toast('Rename failed: ' + e.message, 4000));
        }),
      },
      {
        label: 'Delete project…',
        danger: true,
        action: () => askConfirm(
          'Delete project “' + project.name + '”?',
          'The project is removed and its conversations become Unassigned. The workspace files are not touched.',
          () => {
            void pfApiPost('/api/projects/delete', { project_id: project.project_id })
              .then(() => scheduleRefresh({ delayMs: 100 }))
              .catch((e) => toast('Delete failed: ' + e.message, 4000));
          },
        ),
      },
    );
    return items;
  }

  /* ── dialogs ────────────────────────────────────────────────────────── */

  function openDialog({ title, bodyNode, onMount, width }) {
    closeDialog();
    const overlay = el('div', 'pf-overlay');
    overlay.id = 'pf-dialog-overlay';
    const dlg = el('div', 'pf-dialog');
    dlg.style.maxWidth = (width || 480) + 'px';
    const head = el('div', 'pf-dialog-head');
    const t = el('div', 'pf-dialog-title', title);
    head.appendChild(t);
    const x = el('button', 'pf-dialog-x', '×');
    x.type = 'button';
    x.onclick = closeDialog;
    head.appendChild(x);
    dlg.appendChild(head);
    const body = el('div', 'pf-dialog-body');
    body.appendChild(bodyNode);
    dlg.appendChild(body);
    overlay.appendChild(dlg);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeDialog(); });
    document.body.appendChild(overlay);
    if (onMount) onMount(dlg);
    return overlay;
  }
  function closeDialog() {
    const o = document.getElementById('pf-dialog-overlay');
    if (o) o.remove();
  }

  function askPrompt(title, current, onOk) {
    const wrap = el('div');
    const input = el('input', 'pf-input');
    input.type = 'text';
    input.value = current || '';
    wrap.appendChild(input);
    const err = el('div', 'pf-dialog-err');
    wrap.appendChild(err);
    const row = el('div', 'pf-dialog-actions');
    const cancel = el('button', 'pf-btn', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = closeDialog;
    const ok = el('button', 'pf-btn pf-btn-primary', 'Save');
    ok.type = 'button';
    ok.onclick = () => {
      const v = input.value.trim();
      if (!v) { err.textContent = 'Name cannot be empty'; return; }
      closeDialog();
      onOk(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    row.appendChild(cancel);
    row.appendChild(ok);
    wrap.appendChild(row);
    const ov = openDialog({ title, bodyNode: wrap });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    void ov;
  }

  function askConfirm(title, message, onOk) {
    const wrap = el('div');
    wrap.appendChild(el('div', 'pf-dialog-text', message));
    const row = el('div', 'pf-dialog-actions');
    const cancel = el('button', 'pf-btn', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = closeDialog;
    const ok = el('button', 'pf-btn pf-btn-danger', 'Confirm');
    ok.type = 'button';
    ok.onclick = () => { closeDialog(); onOk(); };
    row.appendChild(cancel);
    row.appendChild(ok);
    wrap.appendChild(row);
    openDialog({ title, bodyNode: wrap });
  }

  function workspaceChoices() {
    const set = new Set();
    if (state.defaultWorkspace) set.add(state.defaultWorkspace);
    for (const s of state.sessions) if (s.workspace) set.add(s.workspace);
    for (const pid of Object.keys(state.bindings)) set.add(state.bindings[pid].workspace);
    return Array.from(set).sort();
  }

  function openWorkspaceDialog(project) {
    const wrap = el('div');
    const hint = el('div', 'pf-dialog-text');
    hint.textContent = 'Workspace is the folder the agent works in for new chats of this project. ' +
      'Its HERMES.md is loaded into the agent context automatically.';
    wrap.appendChild(hint);
    const current = (state.bindings[project.project_id] || {}).workspace || '';
    const input = el('input', 'pf-input');
    input.type = 'text';
    input.value = current;
    input.placeholder = '~/projects/<name>';
    input.setAttribute('list', 'pf-ws-list');
    wrap.appendChild(input);
    const dl = el('datalist', null);
    dl.id = 'pf-ws-list';
    for (const w of workspaceChoices()) {
      const o = el('option');
      o.value = w;
      dl.appendChild(o);
    }
    wrap.appendChild(dl);
    const err = el('div', 'pf-dialog-err');
    wrap.appendChild(err);
    const row = el('div', 'pf-dialog-actions');
    const cancel = el('button', 'pf-btn', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = closeDialog;
    if (current) {
      const unbind = el('button', 'pf-btn pf-btn-danger', 'Unbind');
      unbind.type = 'button';
      unbind.onclick = () => {
        closeDialog();
        void sidecarPost('/v1/bindings', { project_id: project.project_id, workspace: null })
          .then(() => { toast('Workspace unbound'); scheduleRefresh({ delayMs: 100 }); })
          .catch((e) => toast('Unbind failed: ' + e.message, 4000));
      };
      row.appendChild(unbind);
    }
    const save = el('button', 'pf-btn pf-btn-primary', 'Save');
    save.type = 'button';
    save.onclick = async () => {
      const v = input.value.trim();
      if (!v) { err.textContent = 'Workspace path is required'; return; }
      err.textContent = '';
      try {
        await sidecarPost('/v1/bindings', { project_id: project.project_id, workspace: v });
        closeDialog();
        toast('Workspace saved');
        scheduleRefresh({ delayMs: 100 });
      } catch (e) {
        err.textContent = e.message || String(e);
      }
    };
    row.appendChild(cancel);
    row.appendChild(save);
    wrap.appendChild(row);
    openDialog({ title: (current ? 'Change workspace — ' : 'Set workspace — ') + project.name, bodyNode: wrap, width: 560 });
    setTimeout(() => input.focus(), 30);
  }

  async function openHermesMdDialog(project) {
    const binding = state.bindings[project.project_id];
    if (!binding) { toast('Set a workspace first'); return; }
    const wrap = el('div');
    const status = el('div', 'pf-dialog-text', 'Loading…');
    wrap.appendChild(status);
    const ta = el('textarea', 'pf-textarea');
    ta.spellcheck = false;
    ta.placeholder = '# Project\n\n…';
    wrap.appendChild(ta);
    const err = el('div', 'pf-dialog-err');
    wrap.appendChild(err);
    const row = el('div', 'pf-dialog-actions');
    const cancel = el('button', 'pf-btn', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = closeDialog;
    const save = el('button', 'pf-btn pf-btn-primary', 'Save');
    save.type = 'button';
    save.onclick = async () => {
      try {
        await sidecarPut('/v1/hermes-md?workspace=' + encodeURIComponent(binding.workspace), { content: ta.value });
        toast('HERMES.md saved');
        closeDialog();
      } catch (e) {
        err.textContent = e.message || String(e);
      }
    };
    row.appendChild(cancel);
    row.appendChild(save);
    wrap.appendChild(row);
    openDialog({ title: 'Project instructions — ' + project.name, bodyNode: wrap, width: 720 });
    try {
      const d = await sidecarGet('/v1/hermes-md?workspace=' + encodeURIComponent(binding.workspace));
      if (d && d.exists) {
        ta.value = d.content;
        status.textContent = 'HERMES.md · ' + (d.size || 0) + ' bytes · ' + (d.path || '');
      } else if (d && d.error) {
        status.textContent = d.error;
      } else {
        status.textContent = 'No HERMES.md yet — a template will be created on first save.';
        try {
          const t = await sidecarGet('/v1/template');
          ta.value = t.template;
        } catch (_) { ta.value = '# Project\n\n'; }
      }
    } catch (e) {
      status.textContent = 'Failed to load: ' + (e.message || e);
    }
  }

  /* ── boot ───────────────────────────────────────────────────────────── */

  function boot() {
    if (state.ready) return;
    state.ready = true;
    state.collapsed = lsGetObj(LS.collapse, {});
    initStorage();
    checkCompatibility();
    try {
      buildDom();
    } catch (err) {
      console.error('[project-folders] DOM init failed; staying out of the way', err);
      state.ready = false;
      return;
    }
    applyMode();
    void refresh({});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0), { once: true });
  } else {
    setTimeout(boot, 0);
  }
})();