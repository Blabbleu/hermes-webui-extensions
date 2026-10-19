/* Hermes WebUI extension: Project Folders (lite)
 *
 * Groups the chat sidebar into collapsible project folders on top of core's
 * own project model. This is a client-side-only extension: it ships no
 * sidecar, opens no new event stream, and stores nothing outside browser
 * storage. Every server-side behavior goes through stock core WebUI APIs:
 *
 *   - project list + workspace/model bindings:  GET /api/projects,
 *     POST /api/projects/bind (bindings are CORE state, not extension state);
 *   - new chat in a project: core newSession(true, {project_id, ...bindings})
 *     (core skips its own binding merge when project_id is passed explicitly,
 *     so we read the project's bindings and forward them ourselves);
 *   - open a chat: core _openSidebarSession() so the mobile drawer closes and
 *     session-open hooks run;
 *   - regenerate title: POST /api/session/title/regenerate;
 *   - HERMES.md: GET /api/file + POST /api/file/save against a session in the
 *     project workspace (core enforces path safety and preserves modes);
 *   - move/rename/archive/delete: core session APIs.
 *
 * Sidebar refresh piggybacks on core's own refresh pipeline (window.
 * refreshSessionList wrapper) plus a visibility-aware poll; we never open a
 * second EventSource. Repaints are skipped when the snapshot hash is
 * unchanged; rows are reconciled by session_id and focus is restored.
 */
(() => {
  'use strict';
  if (window.__PF_INJECTED__) return;
  window.__PF_INJECTED__ = true;

  const EXT_ID = 'project-folders';
  const PAGE_SIZE = 5; // rows per expanded group before "Show more"
  const POLL_MS = 30000;
  const LS = {
    mode: 'hermes-pf-mode',
    collapse: 'hermes-pf-collapse',
  };
  const DND_MIME = 'application/x-hermes-pf';

  /* ── core accessors (all feature-checked) ───────────────────────────── */

  // Core loads as classic deferred scripts before extension scripts, so
  // top-level functions are on window and top-level consts are reachable as
  // bare lexical names. Every access is guarded: missing hooks degrade.
  function coreFn(name) {
    try {
      const f = window[name];
      return typeof f === 'function' ? f : null;
    } catch (_) { return null; }
  }
  function coreT(key) {
    // core i18n: t() is a top-level function; returns the key literally when
    // missing, which we treat as "no label".
    try {
      /* eslint-disable-next-line no-undef */
      if (typeof t !== 'function') return null;
      /* eslint-disable-next-line no-undef */
      const v = t(key);
      return (typeof v === 'string' && v && v !== key) ? v : null;
    } catch (_) { return null; }
  }
  function coreS() {
    try {
      /* eslint-disable-next-line no-uniq */
      return (typeof S !== 'undefined' && S) ? S : null;
    } catch (_) { return null; }
  }
  function coreConst(name, probe) {
    // read-only access to lexical core consts (ICONS/LOCALES) without eval
    try { return probe(); } catch (_) { return null; }
  }
  // Static SVG markup only (core's own ICONS strings, or the fixed fallbacks
  // below); never interpolated with user data.
  const PF_ICONS = {
    plus: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
    gear: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    more: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="8" cy="3" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="8" cy="13" r="1.25"/></svg>',
  };
  function iconMarkup(name) {
    const core = coreConst('ICONS', () => {
      /* eslint-disable-next-line no-undef */
      return (typeof ICONS === 'object' && ICONS && typeof ICONS[name] === 'string') ? ICONS[name] : null;
    });
    return core || PF_ICONS[name] || '';
  }

  // i18n: route every label through core's t(); pf_* keys are seeded into
  // core's locale catalog at boot (core's t() reads LOCALES.en as fallback),
  // and every call carries an English literal as last-resort fallback.
  const PF_KEYS = {
    pf_unassigned: 'Unassigned',
    pf_new_chat_here: 'New chat here',
    pf_new_chat_in: 'New chat in {0}',
    pf_new_chat_unassigned: 'New unassigned chat',
    pf_folders_mode_on: 'Project folders: on',
    pf_folders_mode_off: 'Project folders: off',
    pf_show_more: 'Show {0} more · {1} remaining',
    pf_show_less: 'Show less',
    pf_set_workspace: 'Set workspace…',
    pf_change_workspace: 'Change workspace…',
    pf_unbind_workspace: 'Unbind workspace',
    pf_hermes_md: 'Project instructions…',
    pf_project_rename: 'Rename project…',
    pf_project_delete: 'Delete project…',
    pf_no_project_filter: 'No project (Unassigned)',
    pf_use_project_workspace: 'Use project workspace',
    pf_read_only_session: 'Read-only session (imported)',
    pf_no_projects_hint: 'No conversations yet. Create a project or start a chat.',
    pf_conversation_actions: 'Conversation actions',
    pf_project_actions: 'Project actions',
    pf_title_regenerated: 'Title updated',
    pf_title_regenerating: 'Regenerating title…',
    pf_untitled: 'Untitled',
    pf_hermes_md_missing: 'No HERMES.md exists in this workspace yet. Core\'s file API only edits existing files — create the file in the workspace first (for example via a project chat), then reopen this dialog.',
    pf_hermes_md_no_session: 'Open or create a chat in the project workspace first — core\'s file API works through a session in that workspace.',
    pf_empty_group: 'No chats in this project yet.',
    pf_moved_to_project: 'Moved to project',
    pf_removed_from_project: 'Removed from project',
    pf_archived_note: 'Archived — archived chats live in the classic sidebar (turn folders off to see them)',
    pf_workspace_unbound: 'Workspace unbound',
    pf_workspace_bound: 'Workspace bound',
    pf_bind_failed: 'Workspace bind failed',
    pf_failed_to_load: 'Failed to load',
    pf_new_chat_failed: 'New chat failed',
    pf_move_failed: 'Move failed',
    pf_rename_failed: 'Rename failed',
    pf_delete_failed: 'Delete failed',
    pf_regenerate_failed: 'Regenerate title failed',
    pf_workspace_update_failed: 'Workspace update failed',
    pf_workspace_set: 'Workspace set to {0}',
    pf_use_project_workspace_confirm: 'Change this conversation\'s working directory to {0}?',
    pf_workspace_prompt_message: 'New chats in this project start in this folder (validated by the WebUI server). The binding is core\'s own, shared with core\'s project quick-create.',
    pf_project_delete_confirm: 'Conversations become Unassigned; workspace files are untouched.',
    pf_empty_unassigned: 'No unassigned chats.',
    pf_loading: 'Loading conversations…',
    pf_load_failed_retrying: 'Could not load conversations. Retrying…',
    pf_incompatible: 'Project Folders is inactive: this WebUI version is missing expected hooks ({0}).',
    pf_incompatible_hint: 'Switch to the classic sidebar (folder icon in the Chat panel header) to keep using the standard list.',
    pf_hermes_md_no_workspace: 'Set a workspace for this project first.',
    pf_hermes_md_saved: 'HERMES.md saved',
    pf_failed_to_save: 'HERMES.md save failed',
    pf_save: 'Save',
    pf_bytes: '{0} bytes',
    pf_now: 'now',
    pf_loading_file: 'Loading…',
    pf_close: 'Close',
  };
  (function seedLocaleKeys() {
    coreConst('LOCALES', () => {
      /* eslint-disable-next-line no-undef */
      if (typeof LOCALES === 'object' && LOCALES && LOCALES.en) {
        /* eslint-disable-next-line no-undef */
        for (const k of Object.keys(PF_KEYS)) {
          /* eslint-disable-next-line no-undef */
          if (!(k in LOCALES.en)) LOCALES.en[k] = PF_KEYS[k];
        }
      }
      return true;
    });
  })();
  function L(key, fallback) {
    return coreT(key) || fallback;
  }
  function Lf(key, fallback, ...args) {
    const raw = coreT(key) || fallback;
    try {
      return raw.replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)]));
    } catch (_) { return fallback; }
  }

  /* ── state ───────────────────────────────────────────────────────────── */

  const state = {
    ready: false,
    loaded: false, // first successful projects+sessions round finished
    loadError: false, // last round failed before anything was loaded
    compatible: true,
    compatReason: '',
    mode: 'folders',
    projects: [],
    sessions: [],
    collapsed: {},
    visibleCounts: {}, // per-group pagination window (display-only)
    search: '',
    lastHash: '',
    titleBusy: {}, // session_id -> true while regenerating
  };

  let pfRoot = null;
  let scrollEl = null;
  let debounceTimer = 0;
  let refreshInFlight = false;
  let pendingFollowup = false;
  let pollTimer = 0;
  let timeTimer = 0;
  let menuSeq = 0;
  let pendingSince = 0; // first-request timestamp of the current debounce window
  let lastFocusKey = null;
  const groupDom = new Map(); // group key -> {groupEl, bodyEl, header:els, rows:Map}

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

  function relTime(ts) {
    if (!ts) return '';
    const d = Date.now() / 1000 - Number(ts);
    if (!isFinite(d) || d < 0) return '';
    if (d < 60) return L('pf_now', 'now');
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
    try {
      const f = coreFn('showToast');
      if (f) { f(msg, ms || 4000); return; }
    } catch (_) {}
    console.warn('[' + EXT_ID + ']', msg);
  }

  function activeSid() {
    const s = coreS();
    try { return (s && s.session && s.session.session_id) || null; } catch (_) { return null; }
  }

  function isReadOnlySession(s) {
    return !!(s && (s.read_only || s.is_read_only));
  }

  /* ── API helpers (same-origin, stock core endpoints only) ───────────── */

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
  const apiGet = (path) => pfFetch(path, { method: 'GET' });
  const apiPost = (path, body) => pfFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  /* ── data loading + refresh pipeline ────────────────────────────────── */

  async function loadProjects() {
    const d = await apiGet('/api/projects');
    const arr = Array.isArray(d && d.projects) ? d.projects : [];
    state.projects = arr.filter(p => p && typeof p.project_id === 'string' && typeof p.name === 'string');
  }
  function syncSearchFromDom() {
    try {
      const input = document.getElementById('sessionSearch');
      if (!input) return;
      state.search = (input.value || '').trim();
    } catch (_) {}
  }

  function sessionsUrl() {
    // mirror core's own sidebar scoping (sessions.js _sessionListQueryString):
    // the folder view spans all projects, so exclude_hidden is always on; the
    // WebUI/CLI source tab and the all-profiles switch are read from core.
    const qs = ['sidebar_source=webui', 'exclude_hidden=1'];
    try {
      if (window._showCliSessions) {
        /* eslint-disable-next-line no-undef */
        const f = (typeof _sessionSourceFilter !== 'undefined' && _sessionSourceFilter) ? _sessionSourceFilter : 'webui';
        qs[0] = 'sidebar_source=' + encodeURIComponent(f);
      }
    } catch (_) {}
    try {
      /* eslint-disable-next-line no-undef */
      if (typeof _showAllProfiles !== 'undefined' && _showAllProfiles) qs.push('all_profiles=1');
    } catch (_) {}
    return '/api/sessions?' + qs.join('&');
  }

  async function loadSessions() {
    const d = await apiGet(sessionsUrl());
    const arr = Array.isArray(d && d.sessions) ? d.sessions : [];
    // Archived sessions are out of scope for the folder view (README); the
    // classic sidebar owns them. Everything else — including sessions whose
    // project_id is unknown — is bucketed here.
    state.sessions = arr.filter(s => s && typeof s.session_id === 'string' && !s.archived);
  }

  function projectBindings(p) {
    if (!p) return {};
    const f = coreFn('_projectBindingsForNewSession');
    if (f) {
      try {
        const b = f(p);
        if (b && typeof b === 'object') return b;
      } catch (_) {}
    }
    const out = {};
    const ws = p.default_workspace
      || (Array.isArray(p.workspaces) && p.workspaces[0]) || p.workspace;
    if (ws) out.workspace = ws;
    if (p.model) out.model = p.model;
    if (p.model_provider) out.model_provider = p.model_provider;
    return out;
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
    for (const p of state.projects) {
      mix(p.project_id + '|' + p.name + '|' + (p.color || '') + '|' + (p.default_workspace || '') +
        '|' + (p.model || '') + '|' + (p.model_provider || ''));
    }
    mix('s');
    for (const s of state.sessions) {
      mix(s.session_id + '|' + (s.title || '') + '|' + Math.round(Number(s.last_message_at || s.updated_at || 0)) +
        '|' + (s.project_id || '') + '|' + (s.workspace || '') + '|' + (s.is_streaming || s.active_stream_id ? 1 : 0) +
        '|' + (s.attention ? s.attention.kind || '1' : '') + '|' + (s.pinned ? 1 : 0) +
        '|' + (state.titleBusy[s.session_id] ? 1 : 0));
    }
    mix('m' + state.mode + '|' + (state.search || ''));
    mix('c' + Object.keys(state.collapsed).filter(k => state.collapsed[k]).sort().join(','));
    mix('v' + Object.keys(state.visibleCounts).sort().map(k => k + ':' + state.visibleCounts[k]).join(','));
    mix('a' + (activeSid() || ''));
    mix('l' + (state.loaded ? 1 : 0) + (state.loadError ? 1 : 0));
    return String(h >>> 0);
  }

  function requestRefresh(delayMs) {
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    // max-wait: a sustained stream of core refreshes must not postpone the
    // folder refresh indefinitely
    const waited = now - pendingSince;
    const base = typeof delayMs === 'number' ? delayMs : 250;
    const wait = waited > 1500 ? 0 : base;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      pendingSince = 0;
      void runRefresh();
    }, wait);
  }

  async function runRefresh() {
    if (!state.ready) return;
    if (refreshInFlight) {
      // Queue exactly one follow-up so an update arriving mid-fetch is not
      // lost until the next poll.
      pendingFollowup = true;
      return;
    }
    refreshInFlight = true;
    try {
      // core's boot/bfcache paths can rewrite the search input without any
      // event we observe; re-sync before every data round so the folder view
      // can never keep a filter the classic list has dropped.
      syncSearchFromDom();
      const results = await Promise.allSettled([loadProjects(), loadSessions()]);
      if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') {
        // network hiccup — retry soon, keep the last good render; before the
        // first good round, say so instead of showing a false empty state
        if (!state.loaded && !state.loadError) {
          state.loadError = true;
          refreshNow();
        }
        requestRefresh(8000);
        return;
      }
      state.loaded = true;
      state.loadError = false;
      refreshNow();
    } catch (err) {
      console.warn('[' + EXT_ID + '] refresh failed', err);
    } finally {
      refreshInFlight = false;
      if (pendingFollowup) {
        pendingFollowup = false;
        requestRefresh(0);
      }
    }
  }

  // Repaint only when the snapshot actually changed.
  function refreshNow() {
    const hash = snapshotHash();
    if (hash === state.lastHash) return false;
    state.lastHash = hash;
    render();
    return true;
  }

  /* ── DOM: skeleton ──────────────────────────────────────────────────── */

  function checkCompatibility() {
    const missing = [];
    if (!document.getElementById('sessionList')) missing.push('#sessionList');
    if (!document.getElementById('panelChat')) missing.push('#panelChat');
    if (!coreFn('_openSidebarSession') && !coreFn('loadSession')) missing.push('session open hook');
    state.compatible = !missing.length;
    state.compatReason = missing.join(', ');
  }

  function ensureToggle() {
    const head = document.querySelector('#panelChat .panel-head-actions');
    if (!head) return;
    let btn = document.getElementById('pf-mode-toggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'pf-mode-toggle';
      btn.type = 'button';
      btn.className = 'panel-icon-btn pf-toggle';
      // static markup, no user data
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
      btn.addEventListener('click', () => {
        setMode(state.mode === 'folders' ? 'classic' : 'folders');
      });
      head.insertBefore(btn, head.firstChild);
    }
    const on = state.mode === 'folders';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = on ? L('pf_folders_mode_on', 'Project folders: on')
      : L('pf_folders_mode_off', 'Project folders: off');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.classList.toggle('pf-on', on);
  }

  function buildDom() {
    if (document.getElementById('pf-folders')) {
      pfRoot = document.getElementById('pf-folders');
      scrollEl = document.getElementById('pf-scroll');
    } else {
      pfRoot = el('div', 'pf-root');
      pfRoot.id = 'pf-folders';
      scrollEl = el('div', 'pf-scroll');
      scrollEl.id = 'pf-scroll';
      pfRoot.appendChild(scrollEl);
      const panel = document.getElementById('panelChat');
      const list = document.getElementById('sessionList');
      // Insert before #sessionList so core's search box stays on top.
      if (panel && list && list.parentNode === panel) panel.insertBefore(pfRoot, list);
      else if (panel) panel.appendChild(pfRoot);
      else return;
    }
    ensureToggle();

    // Search state sync: typing fires 'input'; core's clear button and the
    // Escape path rewrite the value WITHOUT an input event, so also watch
    // the clear button's hidden attribute (core keeps it in sync with the
    // value on every filterSessions()/clearSessionSearch() pass), and
    // re-sync unconditionally inside every runRefresh().
    const input = document.getElementById('sessionSearch');
    if (input) {
      const syncSearch = debounce(() => {
        const q = (input.value || '').trim();
        if (q !== state.search) {
          state.search = q;
          refreshNow();
        }
      }, 120);
      input.addEventListener('input', syncSearch);
      const clearBtn = document.getElementById('sessionSearchClear');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => setTimeout(syncSearch, 0));
        try {
          new MutationObserver(syncSearch).observe(clearBtn, {
            attributes: true, attributeFilter: ['hidden'],
          });
        } catch (_) {}
      }
      state.search = (input.value || '').trim();
    }

    // No EventSource here: core owns /api/sessions/events. We piggyback on
    // core's own sidebar refresh pipeline by wrapping window.refreshSessionList
    // (exported by core at sessions.js) — a pure pass-through that also
    // schedules our (hash-guarded, cheap) refresh. A 30s visibility-aware
    // poll covers the rest.
    const orig = window.refreshSessionList;
    if (typeof orig === 'function' && !orig.__pfWrapped) {
      const wrapped = function () {
        const r = orig.apply(this, arguments);
        try {
          if (state.mode === 'folders') requestRefresh(350);
        } catch (_) {}
        return r;
      };
      wrapped.__pfWrapped = true;
      window.refreshSessionList = wrapped;
    }

    pollTimer = setInterval(() => {
      if (document.hidden) return;
      requestRefresh(0);
    }, POLL_MS);
    timeTimer = setInterval(() => {
      if (document.hidden || !scrollEl) return;
      updateTimesInPlace();
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) requestRefresh(300);
    });

    // Active-row highlight without a poll: core's session-open extension hook
    // fires from loadSession(); newSession() owns its own
    // window.refreshSessionList('new-session') call, caught by the wrapper.
    try {
      const reg = coreFn('registerHermesSessionOpenHandler');
      if (reg) reg(() => { refreshNow(); });
    } catch (_) {}
  }

  function setMode(mode) {
    state.mode = mode === 'classic' ? 'classic' : 'folders';
    lsSet(LS.mode, state.mode);
    applyMode();
  }
  function applyMode() {
    try {
      // never hide core's list while incompatible: without the header toggle
      // there would be no way back to the classic sidebar
      document.body.classList.toggle('pf-mode-folders', state.mode === 'folders' && state.compatible);
    } catch (_) {}
    ensureToggle();
    if (state.mode === 'folders') {
      state.lastHash = '';
      refreshNow();
    }
  }

  /* ── DOM: render (reconcile, never full-rebuild per refresh) ─────────── */

  function visibleSessions() {
    const q = state.search.toLowerCase();
    if (!q) return state.sessions;
    return state.sessions.filter((s) => {
      const t0 = String(s.title || '').toLowerCase();
      const sid = String(s.session_id || '').toLowerCase();
      return t0.indexOf(q) !== -1 || sid.indexOf(q) !== -1;
    });
  }

  function rowTs(s) {
    return Number(s.last_message_at || s.updated_at || s.created_at || 0);
  }
  function sortRows(rows) {
    return rows.slice().sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      const d = rowTs(b) - rowTs(a);
      if (d !== 0) return d;
      return String(a.session_id).localeCompare(String(b.session_id));
    });
  }

  function findProject(pid) {
    for (const p of state.projects) if (p.project_id === pid) return p;
    return null;
  }

  function computeGroups() {
    const sessions = visibleSessions();
    const byProject = {};
    const unassigned = [];
    for (const s of sessions) {
      if (s.project_id && findProject(s.project_id)) {
        (byProject[s.project_id] = byProject[s.project_id] || []).push(s);
      } else {
        // Unknown project_id (deleted/cross-profile project) falls back to
        // Unassigned instead of silently disappearing.
        unassigned.push(s);
      }
    }
    const groups = [];
    for (const project of state.projects) {
      groups.push({
        key: project.project_id,
        project,
        rows: sortRows(byProject[project.project_id] || []),
      });
    }
    if (unassigned.length || !state.projects.length) {
      groups.push({ key: 'unassigned', project: null, rows: sortRows(unassigned) });
    }
    return groups;
  }

  function groupVisibleCount(key, rows) {
    let n = Number(state.visibleCounts[key]) || PAGE_SIZE;
    if (n < PAGE_SIZE) n = PAGE_SIZE;
    // The open chat stays visible when it sorts just below the first pages —
    // the window extends up to a cap so one stuck-at-the-bottom chat can
    // never turn the folder into a 200-row list. Beyond the cap the open
    // row appears through "Show more".
    const CAP = PAGE_SIZE * 3;
    const aSid = activeSid();
    if (aSid) {
      const idx = rows.findIndex((r) => r.session_id === aSid);
      if (idx >= n && idx < CAP) n = idx + 1;
    }
    if (n > rows.length) n = rows.length;
    return n;
  }

  function isCollapsed(key) { return !!state.collapsed[key]; }

  function captureFocusKey() {
    try {
      const a = document.activeElement;
      if (!a || !scrollEl || !scrollEl.contains(a)) return null;
      const holder = a.closest('[data-pfk]');
      if (!holder) return null;
      lastFocusKey = holder.getAttribute('data-pfk');
      const group = a.closest('.pf-group');
      return { key: lastFocusKey, group: group ? group.dataset.key : null };
    } catch (_) { return null; }
  }
  function pfkSelector(key) {
    return '[data-pfk="' + (window.CSS && CSS.escape ? CSS.escape(key) : String(key).replace(/["\\]/g, '\\$&')) + '"]';
  }
  function isFocusableNow(n) {
    try {
      if (!n || !n.isConnected || n.disabled || typeof n.focus !== 'function') return false;
      if (n === document.body || n === document.documentElement) return false;
      const cs = getComputedStyle(n);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    } catch (_) { return false; }
  }
  // Move focus to a pf control by key. Returns true when focus landed.
  function focusPfk(key) {
    if (!key || !scrollEl) return false;
    let target = null;
    try { target = scrollEl.querySelector(pfkSelector(key)); } catch (_) { return false; }
    if (!isFocusableNow(target)) return false;
    try { target.focus({ preventScroll: true }); } catch (_) {
      try { target.focus(); } catch (_) { return false; }
    }
    return document.activeElement === target;
  }
  // Focus must never fall to <body> while the user is keyboarding through
  // the list: core treats Enter on <body> as "Allow once" for a visible
  // approval card. When the focused control is gone after a reconcile
  // (deleted row, vanished pager), fall back to its group header, then to
  // the first control in the list, then to the header toggle.
  function restoreFocusKey(cap) {
    if (!cap || !scrollEl) return;
    try {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected && scrollEl.contains(a)) return; // survived
      if (a && a !== document.body && a !== document.documentElement && a.isConnected && !scrollEl.contains(a)) return; // user moved on
    } catch (_) { return; }
    if (focusPfk(cap.key)) return;
    if (cap.group && focusPfk('g:' + cap.group)) return;
    try {
      const first = scrollEl.querySelector('[data-pfk]');
      if (first && focusPfk(first.getAttribute('data-pfk'))) return;
    } catch (_) {}
    try {
      const tog = document.getElementById('pf-mode-toggle');
      if (isFocusableNow(tog)) tog.focus({ preventScroll: true });
    } catch (_) {}
  }

  function render() {
    if (!pfRoot || state.mode !== 'folders') return;
    if (!state.compatible) { renderIncompatible(); return; }
    const focusCap = captureFocusKey();
    if (!state.loaded) {
      // no false "0 chats" flash before the first data round
      setScrollEmpty(state.loadError
        ? L('pf_load_failed_retrying', 'Could not load conversations. Retrying…')
        : L('pf_loading', 'Loading conversations…'));
      return;
    }
    const groups = computeGroups();

    if (!groups.length) {
      setScrollEmpty(L('pf_no_projects_hint', 'No conversations yet. Create a project or start a chat.'));
      if (focusCap) restoreFocusKey(focusCap);
      return;
    }
    clearScrollEmpty();

    // Group order: reconcile existing maps to desired order.
    const seen = new Set();
    let prevEl = null;
    for (const g of groups) {
      seen.add(g.key);
      let dom = groupDom.get(g.key);
      if (!dom) dom = createGroupDom(g);
      updateGroup(g, dom);
      // position
      const anchor = prevEl ? prevEl.nextSibling : scrollEl.firstChild;
      if (anchor !== dom.groupEl) scrollEl.insertBefore(dom.groupEl, anchor);
      prevEl = dom.groupEl;
    }
    for (const [key, dom] of Array.from(groupDom)) {
      if (!seen.has(key)) {
        try { dom.groupEl.remove(); } catch (_) {}
        groupDom.delete(key);
      }
    }

    if (focusCap) restoreFocusKey(focusCap);
  }

  let emptyEl = null;
  function setScrollEmpty(msg) {
    for (const [key, dom] of Array.from(groupDom)) {
      try { dom.groupEl.remove(); } catch (_) {}
      groupDom.delete(key);
    }
    if (!emptyEl) { emptyEl = el('div', 'pf-empty'); scrollEl.appendChild(emptyEl); }
    emptyEl.textContent = msg;
    emptyEl.style.display = '';
  }
  function clearScrollEmpty() {
    if (emptyEl) emptyEl.style.display = 'none';
  }

  function renderIncompatible() {
    scrollEl.innerHTML = '';
    groupDom.clear();
    emptyEl = null;
    const box = el('div', 'pf-empty pf-incompatible');
    box.appendChild(el('div', null, Lf('pf_incompatible', 'Project Folders is inactive: this WebUI version is missing expected hooks ({0}).', state.compatReason)));
    box.appendChild(el('div', 'pf-empty-hint', L('pf_incompatible_hint', 'Switch to the classic sidebar (folder icon in the Chat panel header) to keep using the standard list.')));
    scrollEl.appendChild(box);
  }

  function updateTimesInPlace() {
    if (!scrollEl) return;
    const nodes = scrollEl.querySelectorAll('.pf-row-time[data-ts]');
    for (const n of nodes) n.textContent = relTime(Number(n.dataset.ts || 0));
  }

  /* ── group DOM construction / reconciliation ────────────────────────── */

  function createGroupDom(g) {
    const groupEl = el('div', 'pf-group');
    groupEl.dataset.key = g.key;

    const header = el('div', 'pf-group-header');
    const toggle = el('button', 'pf-group-toggle');
    toggle.type = 'button';
    toggle.dataset.pfk = 'g:' + g.key;
    const chev = el('span', 'pf-chevron');
    toggle.appendChild(chev);
    const dot = el('span', 'pf-dot');
    toggle.appendChild(dot);
    const name = el('span', 'pf-group-name');
    toggle.appendChild(name);
    const cnt = el('span', 'pf-count');
    toggle.appendChild(cnt);
    toggle.addEventListener('click', () => toggleCollapse(g.key));

    const actions = el('span', 'pf-group-actions');
    const plus = el('button', 'pf-icon-btn pf-group-plus');
    plus.type = 'button';
    plus.dataset.pfk = 'gp:' + g.key;
    plus.innerHTML = iconMarkup('plus'); // static SVG
    plus.addEventListener('click', (e) => {
      e.stopPropagation();
      void newChatInProject(g.key === 'unassigned' ? null : g.key);
    });
    const gear = el('button', 'pf-icon-btn pf-group-gear');
    gear.type = 'button';
    gear.dataset.pfk = 'gg:' + g.key;
    gear.innerHTML = iconMarkup('gear'); // static SVG
    gear.setAttribute('aria-haspopup', 'menu');
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      openProjectMenu(g.key, gear);
    });
    actions.appendChild(plus);
    actions.appendChild(gear);
    header.appendChild(toggle);
    header.appendChild(actions);

    // drop target (desktop, drag a row onto the header)
    try {
      if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
        header.addEventListener('dragover', (e) => {
          if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, DND_MIME) !== -1) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            header.classList.add('pf-droptarget');
          }
        });
        header.addEventListener('dragleave', () => header.classList.remove('pf-droptarget'));
        header.addEventListener('drop', (e) => {
          header.classList.remove('pf-droptarget');
          const sid = e.dataTransfer.getData(DND_MIME);
          if (!sid) return;
          e.preventDefault();
          void moveSession(sid, g.key === 'unassigned' ? null : g.key);
        });
      }
    } catch (_) {}

    const bodyEl = el('div', 'pf-group-body');
    groupEl.appendChild(header);
    groupEl.appendChild(bodyEl);

    const dom = {
      groupEl, header, bodyEl,
      els: { chev, dot, name, cnt, plus, gear, toggle },
      rows: new Map(),
      showMore: null,
      showLess: null,
      newChatBtn: null,
      emptyNote: null,
    };
    groupDom.set(g.key, dom);
    return dom;
  }

  function updateGroup(g, dom) {
    const collapsed = isCollapsed(g.key);
    const { chev, dot, name, cnt, plus, gear, toggle } = dom.els;
    chev.textContent = collapsed ? '▸' : '▾';
    const isUn = g.key === 'unassigned';
    const label = isUn ? L('pf_unassigned', 'Unassigned') : (g.project && g.project.name) || 'Project';
    if (name.textContent !== label) name.textContent = label;
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const toggleLabel = (collapsed ? '▸ ' : '▾ ') + label + ' (' + g.rows.length + ')';
    toggle.setAttribute('aria-label', toggleLabel);
    if (cnt.textContent !== String(g.rows.length)) cnt.textContent = String(g.rows.length);
    dot.style.display = (!isUn && g.project && g.project.color) ? '' : 'none';
    if (!isUn && g.project && g.project.color) dot.style.background = g.project.color;
    plus.style.display = isUn ? '' : '';
    plus.title = isUn
      ? L('pf_new_chat_unassigned', 'New unassigned chat')
      : Lf('pf_new_chat_in', 'New chat in {0}', label);
    plus.setAttribute('aria-label', plus.title);
    gear.style.display = '';
    // keep the slot (visibility, not display) so Unassigned's count badge
    // lines up with the project groups; hidden buttons are not focusable
    gear.style.visibility = isUn ? 'hidden' : '';
    gear.setAttribute('aria-hidden', isUn ? 'true' : 'false');
    gear.tabIndex = isUn ? -1 : 0;
    gear.title = L('pf_project_actions', 'Project actions');
    gear.setAttribute('aria-label', gear.title);
    dom.groupEl.classList.toggle('pf-collapsed', collapsed);

    if (collapsed) {
      dom.bodyEl.style.display = 'none';
      return;
    }
    dom.bodyEl.style.display = '';

    const n = groupVisibleCount(g.key, g.rows);
    const wantRows = g.rows.slice(0, n);
    const aSid = activeSid();

    // reconcile rows by session_id
    let prev = dom.bodyEl.firstChild;
    const seen = new Set();
    for (const s of wantRows) {
      seen.add(s.session_id);
      let rowDom = dom.rows.get(s.session_id);
      if (!rowDom) {
        rowDom = createRowDom(s);
        dom.rows.set(s.session_id, rowDom);
      }
      updateRow(s, rowDom, s.session_id === aSid);
      if (prev === rowDom.rowEl) prev = prev.nextSibling;
      else {
        dom.bodyEl.insertBefore(rowDom.rowEl, prev);
      }
    }
    // rows that fell out of the window / group
    for (const [sid, rowDom] of Array.from(dom.rows)) {
      if (seen.has(sid)) continue;
      try { rowDom.rowEl.remove(); } catch (_) {}
      dom.rows.delete(sid);
    }

    // pager + new-chat row (kept after rows, in stable order). Callbacks are
    // re-bound on every reconcile (ensureButton assigns onclick) so a
    // retained button never acts on a stale g.rows snapshot.
    const remaining = g.rows.length - n;
    dom.showMore = ensureButton(dom.bodyEl, dom.showMore, 'pf-showmore', 'sm:' + g.key,
      remaining > 0 ? Lf('pf_show_more', 'Show {0} more · {1} remaining', Math.min(PAGE_SIZE, remaining), remaining) : null,
      () => {
        const btn = dom.showMore;
        const hadFocus = !!btn && document.activeElement === btn;
        const firstNew = g.rows[n];
        state.visibleCounts[g.key] = n + PAGE_SIZE;
        state.lastHash = snapshotHash();
        render();
        // keyboard users land on the first newly revealed chat, not <body>
        if (hadFocus && (!btn || !btn.isConnected || document.activeElement !== btn) && firstNew) {
          focusPfk('r:' + firstNew.session_id);
        }
      });
    dom.emptyNote = ensureText(dom.bodyEl, dom.emptyNote, 'pf-group-empty',
      (n === 0) ? (isUn ? L('pf_empty_unassigned', 'No unassigned chats.') : L('pf_empty_group', 'No chats in this project yet.')) : null);
    dom.showLess = ensureButton(dom.bodyEl, dom.showLess, 'pf-showless', 'sl:' + g.key,
      n > PAGE_SIZE ? L('pf_show_less', 'Show less') : null,
      () => {
        // the vanished button's focus falls back to this folder's header
        // through render()'s generic restore path
        state.visibleCounts[g.key] = PAGE_SIZE;
        state.lastHash = snapshotHash();
        render();
      });
    // The header "+" is the primary new-chat control; the inline row only
    // appears for an empty group (and is hidden on touch, where the header
    // "+" is always visible — see CSS).
    dom.newChatBtn = ensureButton(dom.bodyEl, dom.newChatBtn, 'pf-newchat', 'nc:' + g.key,
      (n === 0) ? '+ ' + L('pf_new_chat_here', 'New chat here') : null,
      () => { void newChatInProject(isUn ? null : g.key); });
    // "New chat here" is always the last row of a group, independent of
    // which pagers were (re)created this pass
    try {
      if (dom.newChatBtn && dom.newChatBtn.parentNode === dom.bodyEl && dom.newChatBtn.nextSibling) {
        dom.bodyEl.appendChild(dom.newChatBtn);
      }
    } catch (_) {}
  }

  function ensureButton(container, current, cls, pfk, label, onClick) {
    if (label === null || label === undefined) {
      if (current) { try { current.remove(); } catch (_) {} }
      return null;
    }
    if (!current || current.parentNode !== container) {
      const b = el('button', cls);
      b.type = 'button';
      b.dataset.pfk = pfk;
      b.textContent = label;
      b.onclick = onClick;
      container.appendChild(b);
      return b;
    }
    if (current.textContent !== label) current.textContent = label;
    current.onclick = onClick; // always the current reconcile's closure
    return current;
  }
  function ensureText(container, current, cls, text) {
    if (!text) {
      if (current) { try { current.remove(); } catch (_) {} }
      return null;
    }
    if (!current || current.parentNode !== container) {
      const d = el('div', cls, text);
      container.appendChild(d);
      return d;
    }
    if (current.textContent !== text) current.textContent = text;
    return current;
  }

  function toggleCollapse(key) {
    state.collapsed[key] = !state.collapsed[key];
    lsSetObj(LS.collapse, state.collapsed);
    if (!state.collapsed[key]) state.visibleCounts[key] = PAGE_SIZE;
    state.lastHash = snapshotHash();
    render();
  }

  /* ── row DOM ─────────────────────────────────────────────────────────── */

  function createRowDom(s) {
    const rowEl = el('div', 'pf-row');
    rowEl.dataset.sid = s.session_id;

    const open = el('button', 'pf-row-open');
    open.type = 'button';
    open.dataset.pfk = 'r:' + s.session_id;
    const title = el('span', 'pf-row-title');
    open.appendChild(title);
    const liveDot = el('span', 'pf-dot pf-dot-live');
    liveDot.style.display = 'none';
    const attDot = el('span', 'pf-dot pf-dot-att');
    attDot.style.display = 'none';
    title.appendChild(el('span', 'pf-row-label'));
    title.appendChild(liveDot);
    title.appendChild(attDot);
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      openSessionRow(s.session_id);
    });

    const time = el('span', 'pf-row-time');
    const more = el('button', 'pf-row-more');
    more.type = 'button';
    more.dataset.pfk = 'm:' + s.session_id;
    more.innerHTML = iconMarkup('more'); // core's static ICONS.more SVG
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-label', L('pf_conversation_actions', 'Conversation actions'));
    more.title = more.getAttribute('aria-label');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openRowMenu(s.session_id, more);
    });

    rowEl.appendChild(open);
    rowEl.appendChild(time);
    rowEl.appendChild(more);

    // drag & drop move (desktop only)
    try {
      if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
        rowEl.setAttribute('draggable', 'true');
        rowEl.addEventListener('dragstart', (e) => {
          try {
            e.dataTransfer.setData(DND_MIME, s.session_id);
            // read the *current* title from state; the closure's snapshot
            // goes stale after a rename
            let cur = s;
            try { cur = state.sessions.find((x) => x.session_id === s.session_id) || s; } catch (_) {}
            e.dataTransfer.setData('text/plain', cur.title || s.session_id);
            e.dataTransfer.effectAllowed = 'move';
            rowEl.classList.add('pf-dragging');
          } catch (_) {}
        });
        rowEl.addEventListener('dragend', () => rowEl.classList.remove('pf-dragging'));
      }
    } catch (_) {}

    const dom = { rowEl, open, title, label: title.querySelector('.pf-row-label'), liveDot, attDot, time, more };
    return dom;
  }

  function updateRow(s, dom, active) {
    const label = state.titleBusy[s.session_id]
      ? L('pf_title_regenerating', 'Regenerating title…')
      : (s.title || L('pf_untitled', 'Untitled'));
    if (dom.label.textContent !== label) dom.label.textContent = label;
    const ts = rowTs(s);
    const tstr = relTime(ts);
    if (dom.time.dataset.ts !== String(ts)) dom.time.dataset.ts = String(ts);
    if (dom.time.textContent !== tstr) dom.time.textContent = tstr;
    const streaming = !!(s.is_streaming || s.active_stream_id);
    dom.liveDot.style.display = streaming ? '' : 'none';
    const att = s.attention && s.attention.kind ? s.attention.kind : '';
    dom.attDot.style.display = (!streaming && att) ? '' : 'none';
    dom.rowEl.classList.toggle('pf-streaming', streaming);
    dom.rowEl.classList.toggle('pf-attention', !streaming && !!att);
    dom.rowEl.classList.toggle('pf-pinned', !!s.pinned);
    dom.rowEl.classList.toggle('pf-readonly', isReadOnlySession(s));
    dom.rowEl.classList.toggle('pf-active', !!active);
    if (active) dom.open.setAttribute('aria-current', 'page');
    else dom.open.removeAttribute('aria-current');
    dom.open.title = s.title || s.session_id;
  }

  /* ── session actions ────────────────────────────────────────────────── */

  function fallbackOpenSid(sid) {
    const load = coreFn('loadSession');
    if (load) { try { load(sid); return; } catch (_) {} }
    try { location.href = '/session/' + encodeURIComponent(sid); } catch (_) {}
  }

  function openSessionRow(sid) {
    const s = state.sessions.find((x) => x.session_id === sid);
    const openFn = coreFn('_openSidebarSession');
    if (openFn && s) {
      // core path: runs extension session-open hooks + closes the mobile drawer
      try {
        const r = openFn(s, {});
        if (r && typeof r.then === 'function') r.then(null, () => fallbackOpenSid(sid));
        return;
      } catch (err) {
        console.warn('[' + EXT_ID + '] _openSidebarSession failed', err);
        fallbackOpenSid(sid);
        return;
      }
    }
    fallbackOpenSid(sid);
  }

  // mirroring core: after deleting/archiving the OPEN chat, move to the most
  // recent remaining conversation so the UI is never bound to a dead id
  function reopenNextAfter(sid) {
    if (activeSid() !== sid) return;
    let next = null;
    for (const s of state.sessions) {
      if (s.session_id === sid) continue;
      if (!next || rowTs(s) > rowTs(next)) next = s;
    }
    if (next) openSessionRow(next.session_id);
    // no remaining session: leave the transcript as-is; the next page load
    // restores cleanly (core's own archive path behaves the same way)
  }

  // keep the open chat's header title in sync (core does this in its own
  // rename/regenerate paths)
  function syncOpenTitle(sid, title) {
    if (!title) return;
    try {
      const s = coreS();
      if (s && s.session && s.session.session_id === sid) {
        s.session.title = title;
        const st = coreFn('syncTopbar');
        if (st) st();
      }
    } catch (_) {}
  }

  async function newChatInProject(projectId) {
    // mirror core's "+" reuse guard (#1171/#1432) for the unscoped case, but
    // only when the empty open chat is itself unassigned: "New unassigned
    // chat" must never leave the user in an empty chat filed under a project
    if (!projectId) {
      try {
        const reusable = coreFn('_currentSessionIsReusableEmptyChat');
        const cur = coreS();
        const curSid = cur && cur.session ? cur.session.session_id : null;
        // Fail safe: reuse only when neither core's open-session record nor
        // the freshest list row puts the empty chat in a project.
        const rec = curSid ? state.sessions.find((x) => x.session_id === curSid) : null;
        const curProject = (cur && cur.session && cur.session.project_id) || (rec && rec.project_id) || null;
        if (reusable && reusable() && !curProject) {
          const closeDrawer = coreFn('closeMobileSidebar');
          if (closeDrawer) { try { closeDrawer(); } catch (_) {} }
          const composer = document.getElementById('msg');
          if (composer && typeof composer.focus === 'function') { try { composer.focus(); } catch (_) {} }
          return;
        }
      } catch (_) {}
    }
    const opts = { project_id: projectId || null };
    if (projectId) {
      // core skips its binding merge when project_id is present, so forward
      // the project's bindings ourselves.
      const p = findProject(projectId);
      const b = projectBindings(p);
      if (b.workspace) opts.workspace = b.workspace;
      if (b.model) opts.model = b.model;
      if (b.model_provider) opts.model_provider = b.model_provider;
    }
    try {
      const ns = coreFn('newSession');
      if (ns) {
        await ns(false, opts);
        const closeDrawer = coreFn('closeMobileSidebar');
        if (closeDrawer) { try { closeDrawer(); } catch (_) {} }
      } else {
        // stock API fallback: same fields explicitly
        const data = await apiPost('/api/session/new', Object.assign({
          workspace: opts.workspace || undefined,
        }, { project_id: opts.project_id }));
        const sid = data && data.session && data.session.session_id;
        if (!sid) throw new Error('session created without id');
        openSessionRow(sid);
      }
      requestRefresh(100);
    } catch (err) {
      toast(L('pf_new_chat_failed', 'New chat failed') + ': ' + ((err && err.message) || err), 4000);
    }
  }

  async function moveSession(sid, projectId) {
    try {
      await apiPost('/api/session/move', { session_id: sid, project_id: projectId || null });
      // keep core's open-session record in step (core's own move path does
      // the same for its cache); the reuse guard and project-scoped core UI
      // read S.session.project_id
      try {
        const cur = coreS();
        if (cur && cur.session && cur.session.session_id === sid) cur.session.project_id = projectId || null;
      } catch (_) {}
      try {
        const row = state.sessions.find((x) => x.session_id === sid);
        if (row) row.project_id = projectId || null;
      } catch (_) {}
      toast(projectId ? L('pf_moved_to_project', 'Moved to project') : L('pf_removed_from_project', 'Removed from project'));
      requestRefresh(100);
    } catch (err) {
      toast(L('pf_move_failed', 'Move failed') + ': ' + ((err && err.message) || err), 4000);
    }
  }

  async function renameSession(s, title) {
    try {
      await apiPost('/api/session/rename', { session_id: s.session_id, title });
      syncOpenTitle(s.session_id, title);
      requestRefresh(100);
    } catch (err) {
      toast(L('pf_rename_failed', 'Rename failed') + ': ' + ((err && err.message) || err), 4000);
    }
  }

  async function regenerateTitle(s) {
    if (state.titleBusy[s.session_id]) return;
    state.titleBusy[s.session_id] = true;
    state.lastHash = snapshotHash();
    render();
    // core's proxy gives up at ~10s; abort past that so a hung endpoint can
    // never park the row in "Regenerating…" forever
    let ctrl = null;
    let timer = 0;
    try { if (typeof AbortController === 'function') ctrl = new AbortController(); } catch (_) {}
    if (ctrl) timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 12000);
    try {
      const d = await pfFetch('/api/session/title/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: s.session_id, prefer_latest: true }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (d && d.title) syncOpenTitle(s.session_id, d.title);
      toast(d && d.title ? d.title : L('pf_title_regenerated', 'Title updated'));
    } catch (err) {
      const label = L('session_title_regenerate_failed', L('pf_regenerate_failed', 'Regenerate title failed'));
      toast(label + ' ' + ((err && err.message) || err), 5000);
    } finally {
      if (timer) clearTimeout(timer);
      delete state.titleBusy[s.session_id];
      state.lastHash = snapshotHash();
      render();
    }
  }

  async function archiveSession(s) {
    try {
      await apiPost('/api/session/archive', { session_id: s.session_id, archived: true });
      toast(L('pf_archived_note', 'Archived — archived chats live in the classic sidebar'));
      reopenNextAfter(s.session_id);
      requestRefresh(100);
    } catch (err) {
      toast(L('session_archive', 'Archive') + ': ' + ((err && err.message) || err), 4000);
    }
  }

  function deleteSession(s) {
    // Delegate to core's own delete flow (exported on window since the
    // first project-capable cores): it owns the worktree-aware confirm copy,
    // the wire-code error messages, per-session storage cleanup (draft,
    // queue, handoff, session pointer) and moving the UI off the deleted
    // chat — including the empty state after the last chat. A second
    // hand-rolled copy of that flow is exactly what drifts from core.
    const coreDelete = coreFn('deleteSession');
    if (!coreDelete) {
      toast(L('pf_delete_failed', 'Delete failed') + ': deleteSession unavailable', 4000);
      return;
    }
    Promise.resolve()
      .then(() => coreDelete(s.session_id))
      .then(() => requestRefresh(100), (err) => {
        toast(L('pf_delete_failed', 'Delete failed') + ': ' + ((err && err.message) || err), 4000);
        requestRefresh(100);
      });
  }

  async function useProjectWorkspace(s, workspace) {
    // The OPEN chat goes through core's own workspace switch so the composer,
    // pending profile-workspace override, topbar and file tree all follow
    // (a bare /api/session/update leaves S.session.workspace stale and the
    // next send restores the old directory).
    const sw = coreFn('switchToWorkspace');
    if (sw && activeSid() === s.session_id) {
      try { await sw(workspace); } catch (err) {
        toast(L('pf_workspace_update_failed', 'Workspace update failed') + ': ' + ((err && err.message) || err), 4000);
      }
      requestRefresh(100);
      return;
    }
    try {
      const d = await apiPost('/api/session/update', { session_id: s.session_id, workspace });
      const applied = (d && d.session && d.session.workspace) || workspace;
      // the target may have become the open chat while the request ran
      const cur = coreS();
      if (cur && cur.session && cur.session.session_id === s.session_id) cur.session.workspace = applied;
      toast(Lf('pf_workspace_set', 'Workspace set to {0}', applied));
      requestRefresh(100);
    } catch (err) {
      toast(L('pf_workspace_update_failed', 'Workspace update failed') + ': ' + ((err && err.message) || err), 4000);
    }
  }

  /* ── menus ───────────────────────────────────────────────────────────── */

  // Preferred path: core's own session-action menu builder (a11y, styling,
  // keyboard). Fallback: an equivalent menu we own (role=menu, buttons,
  // Escape/outside-click close, focus restore).
  let ownMenu = null;
  let ownMenuCleanup = null;

  function closeOwnMenu() {
    if (ownMenuCleanup) { try { ownMenuCleanup(); } catch (_) {} ownMenuCleanup = null; }
    if (ownMenu) { try { ownMenu.remove(); } catch (_) {} ownMenu = null; }
  }

  function openOwnMenu(items, anchor, ariaLabel) {
    closeOwnMenu();
    const prevFocus = document.activeElement;
    const menu = el('div', 'pf-menu');
    menu.setAttribute('role', 'menu');
    if (ariaLabel) menu.setAttribute('aria-label', ariaLabel);
    for (const it of items) {
      if (it.separator) { menu.appendChild(el('div', 'pf-menu-sep')); continue; }
      const b = el('button', 'pf-menu-item' + (it.danger ? ' pf-menu-danger' : ''), it.label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      if (it.disabled) { b.disabled = true; }
      else b.addEventListener('click', () => { closeOwnMenu(); void it.action(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 220;
    let x = r.right - mw;
    if (x < 8) x = 8;
    let y = r.bottom + 4;
    const mh = menu.offsetHeight || 120;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    ownMenu = menu;
    const ident = anchorIdentity(anchor);
    const onDoc = (e) => { if (!menu.contains(e.target)) closeOwnMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeOwnMenu(); } };
    const onScroll = () => closeOwnMenu();
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    ownMenuCleanup = () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      if (isFocusableNow(anchor)) {
        try { anchor.focus({ preventScroll: true }); return; } catch (_) {}
      }
      if (isFocusableNow(prevFocus)) {
        try { prevFocus.focus({ preventScroll: true }); return; } catch (_) {}
      }
      // focus is still inside the menu being removed: force the re-home
      restoreFocusNear(null, ident, true);
    };
    try {
      const first = menu.querySelector('.pf-menu-item:not([disabled])');
      if (first) first.focus({ preventScroll: true });
    } catch (_) {}
  }

  let coreMenuEl = null;
  let coreMenuAnchor = null;
  function anchorIdentity(anchor) {
    let key = null;
    let group = null;
    try {
      key = anchor && anchor.getAttribute ? anchor.getAttribute('data-pfk') : null;
      const g = anchor && anchor.closest ? anchor.closest('.pf-group') : null;
      group = g ? g.dataset.key : null;
    } catch (_) {}
    return { key, group };
  }
  // Put focus back near a menu's trigger: the trigger itself, its rebuilt
  // replacement (same data-pfk), its folder header, then the header toggle.
  function restoreFocusNear(anchor, ident, force) {
    if (!force) {
      try {
        const a = document.activeElement;
        if (a && a !== document.body && a !== document.documentElement && a.isConnected) return;
      } catch (_) { return; }
    }
    if (isFocusableNow(anchor)) {
      try { anchor.focus({ preventScroll: true }); if (document.activeElement === anchor) return; } catch (_) {}
    }
    if (ident && ident.key && focusPfk(ident.key)) return;
    if (ident && ident.group && focusPfk('g:' + ident.group)) return;
    try {
      const tog = document.getElementById('pf-mode-toggle');
      if (isFocusableNow(tog)) tog.focus({ preventScroll: true });
    } catch (_) {}
  }
  // Core closes its menu on Escape, outside clicks, scrolls outside its own
  // list, and actions; only some of those restore focus, and none can find a
  // trigger that a refresh rebuilt. Watch the menu's removal and, if focus
  // was left on <body>, re-home it (synchronously, as a microtask, so no
  // later key event can reach core's Enter-approves shortcut first).
  function watchCoreMenuTeardown(menu, anchor) {
    const ident = anchorIdentity(anchor);
    try {
      const obs = new MutationObserver(() => {
        if (menu.isConnected) return;
        obs.disconnect();
        restoreFocusNear(anchor, ident);
      });
      obs.observe(document.body, { childList: true });
    } catch (_) {}
  }
  function openMenu(items, anchor, ariaLabel) {
    const build = coreFn('_buildSessionAction');
    const mount = coreFn('_mountSessionActionMenu');
    const closeCore = coreFn('closeSessionActionMenu');
    if (build && mount) {
      // One menu at a time, like core's own trigger: core's mount helper does
      // not retire a menu that is already open, and a second click on the
      // same trigger toggles it closed.
      if (coreMenuEl && coreMenuEl.isConnected) {
        const same = coreMenuAnchor === anchor;
        if (closeCore) { try { closeCore({ restoreFocus: false }); } catch (_) {} }
        try { if (coreMenuEl.isConnected) coreMenuEl.remove(); } catch (_) {}
        coreMenuEl = null;
        coreMenuAnchor = null;
        if (same) {
          try { if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true }); } catch (_) {}
          return;
        }
      }
      const menu = document.createElement('div');
      menu.className = 'session-action-menu';
      menu.id = 'pf-action-menu-' + (++menuSeq);
      menu.setAttribute('role', 'menu');
      if (ariaLabel) menu.setAttribute('aria-label', ariaLabel);
      let iconSet = null;
      try {
        /* eslint-disable-next-line no-undef */
        iconSet = (typeof ICONS === 'object' && ICONS) ? ICONS : null;
      } catch (_) { iconSet = null; }
      for (const it of items) {
        if (it.separator) { menu.appendChild(el('div', 'pf-menu-sep')); continue; }
        const icon = (it.icon && iconSet && iconSet[it.icon]) || '';
        const action = build(it.label, it.meta || '', icon, async () => {
          if (closeCore) { try { closeCore({ restoreFocus: false }); } catch (_) {} }
          // Put focus back on the trigger BEFORE the action runs, so a
          // dialog it opens restores there and a plain action (move,
          // archive, regenerate) never leaves focus on <body>, where core
          // treats Enter as "Allow once" for a visible approval card.
          try { if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true }); } catch (_) {}
          void it.action();
        }, it.danger ? 'session-action-danger' : '');
        if (it.disabled) {
          action.disabled = true;
        }
        menu.appendChild(action);
      }
      mount(menu, { session_id: 'pf-menu-' + menuSeq }, anchor);
      coreMenuEl = menu;
      coreMenuAnchor = anchor;
      watchCoreMenuTeardown(menu, anchor);
      return;
    }
    openOwnMenu(items, anchor, ariaLabel);
  }

  function rowMenuItems(s) {
    const items = [];
    if (isReadOnlySession(s)) {
      items.push({ label: L('pf_read_only_session', 'Read-only session (imported)'), disabled: true, action: () => {} });
      return items;
    }
    const moveMeta = L('session_move_project', 'Move to project');
    for (const p of state.projects) {
      const cur = s.project_id === p.project_id;
      items.push({
        label: (cur ? '✓ ' : '') + p.name,
        meta: moveMeta,
        icon: 'folder',
        disabled: cur,
        action: () => void moveSession(s.session_id, p.project_id),
      });
    }
    if (s.project_id) {
      items.push({
        label: L('pf_no_project_filter', 'No project (Unassigned)'),
        meta: moveMeta,
        icon: 'folder',
        action: () => void moveSession(s.session_id, null),
      });
    }
    if (state.projects.length || s.project_id) items.push({ separator: true });
    items.push({
      label: L('session_rename', 'Rename') + '…',
      icon: 'edit',
      action: () => {
        const prompt = coreFn('showPromptDialog');
        if (prompt) {
          prompt({ title: L('session_rename', 'Rename'), value: s.title || '', selectAll: true })
            .then((v) => { if (v && v.trim()) void renameSession(s, v.trim()); })
            .catch(() => {});
          return;
        }
        const v = window.prompt(L('session_rename', 'Rename'), s.title || '');
        if (v && v.trim()) void renameSession(s, v.trim());
      },
    });
    items.push({
      label: L('session_title_regenerate', 'Regenerate title'),
      meta: L('session_title_regenerate_desc', 'Generate a new title from the conversation'),
      icon: 'spark',
      action: () => void regenerateTitle(s),
    });
    // explicit "use project workspace" (moving a session never rewrites its
    // workspace implicitly; this is the deliberate version)
    const proj = s.project_id ? findProject(s.project_id) : null;
    const bindings = proj ? projectBindings(proj) : {};
    if (bindings.workspace && s.workspace && s.workspace !== bindings.workspace) {
      items.push({
        label: L('pf_use_project_workspace', 'Use project workspace'),
        meta: bindings.workspace,
        icon: 'folder',
        action: () => {
          const confirm = coreFn('showConfirmDialog');
          if (confirm) {
            confirm({
              title: L('pf_use_project_workspace', 'Use project workspace'),
              message: Lf('pf_use_project_workspace_confirm', 'Change this conversation\'s working directory to {0}?', bindings.workspace),
              danger: true,
            }).then((ok) => { if (ok) void useProjectWorkspace(s, bindings.workspace); }).catch(() => {});
            return;
          }
          void useProjectWorkspace(s, bindings.workspace);
        },
      });
    }
    items.push({ separator: true });
    items.push({
      label: L('session_archive', 'Archive'),
      icon: 'archive',
      action: () => void archiveSession(s),
    });
    items.push({
      label: L('session_delete', 'Delete') + '…',
      icon: 'trash',
      danger: true,
      action: () => deleteSession(s),
    });
    return items;
  }

  function openRowMenu(sid, anchor) {
    const s = state.sessions.find((x) => x.session_id === sid);
    if (!s) return;
    openMenu(rowMenuItems(s), anchor, L('pf_conversation_actions', 'Conversation actions'));
  }

  function openProjectMenu(pid, anchor) {
    const project = findProject(pid);
    if (!project) return;
    const bindings = projectBindings(project);
    const items = [
      {
        label: bindings.workspace
          ? L('pf_change_workspace', 'Change workspace…')
          : L('pf_set_workspace', 'Set workspace…'),
        meta: bindings.workspace || '',
        icon: 'folder',
        action: () => openWorkspacePrompt(project),
      },
    ];
    if (bindings.workspace) {
      items.push({
        label: L('pf_unbind_workspace', 'Unbind workspace'),
        action: () => void bindWorkspace(project, null),
      });
    }
    // Kept enabled: a disabled item's reason would live only in a tooltip that
    // touch users never see. The action itself explains what is missing.
    items.push({
      label: L('pf_hermes_md', 'Project instructions (HERMES.md)…'),
      meta: bindings.workspace
        ? (hermesMdSession(project) ? bindings.workspace + '/HERMES.md' : L('pf_hermes_md_no_session', 'Open or create a chat in the project workspace first.'))
        : L('pf_hermes_md_no_workspace', 'Set a workspace for this project first.'),
      icon: 'edit',
      action: () => openHermesMdDialog(project),
    });
    items.push({ separator: true });
    items.push({
      label: L('pf_project_rename', 'Rename project…'),
      icon: 'edit',
      action: () => renameProject(project),
    });
    items.push({
      label: L('pf_project_delete', 'Delete project…'),
      icon: 'trash',
      danger: true,
      action: () => deleteProject(project),
    });
    openMenu(items, anchor, L('pf_project_actions', 'Project actions'));
  }

  /* ── project / workspace actions (core-owned state via core APIs) ───── */

  async function bindWorkspace(project, workspace) {
    try {
      if (workspace === null) {
        await apiPost('/api/projects/bind', { project_id: project.project_id, workspaces: null });
        toast(L('pf_workspace_unbound', 'Workspace unbound'));
      } else {
        await apiPost('/api/projects/bind', { project_id: project.project_id, default_workspace: workspace });
        toast(L('pf_workspace_bound', 'Workspace bound'));
      }
      requestRefresh(100);
    } catch (err) {
      toast(L('pf_bind_failed', 'Workspace bind failed') + ': ' + ((err && err.message) || err), 5000);
    }
  }

  function openWorkspacePrompt(project) {
    const prompt = coreFn('showPromptDialog');
    const current = projectBindings(project).workspace || '';
    const run = (v) => {
      if (v == null) return;
      const path = String(v).trim();
      if (!path) return;
      void bindWorkspace(project, path);
    };
    if (prompt) {
      prompt({
        title: (current ? L('pf_change_workspace', 'Change workspace…') : L('pf_set_workspace', 'Set workspace…'))
          + ' — ' + project.name,
        message: L('pf_workspace_prompt_message', 'New chats in this project start in this folder (validated by the WebUI server). The binding is core\'s own, shared with core\'s project quick-create.'),
        value: current,
        placeholder: '/path/to/project',
      }).then(run).catch(() => {});
      return;
    }
    const v = window.prompt((current ? L('pf_change_workspace', 'Change workspace…') : L('pf_set_workspace', 'Set workspace…')) + ' — ' + project.name, current);
    run(v);
  }

  function renameProject(project) {
    const prompt = coreFn('showPromptDialog');
    const run = async (v) => {
      if (v == null) return;
      const name = String(v).trim();
      if (!name || name === project.name) return;
      try {
        await apiPost('/api/projects/rename', { project_id: project.project_id, name });
        requestRefresh(100);
      } catch (err) {
        toast(L('pf_rename_failed', 'Rename failed') + ': ' + ((err && err.message) || err), 4000);
      }
    };
    if (prompt) {
      prompt({ title: L('pf_project_rename', 'Rename project…'), value: project.name, selectAll: true })
        .then(run).catch(() => {});
      return;
    }
    const v = window.prompt(L('pf_project_rename', 'Rename project…'), project.name);
    void run(v);
  }

  function deleteProject(project) {
    const confirm = coreFn('showConfirmDialog');
    const run = async () => {
      try {
        await apiPost('/api/projects/delete', { project_id: project.project_id });
        requestRefresh(100);
      } catch (err) {
        toast(L('pf_delete_failed', 'Delete failed') + ': ' + ((err && err.message) || err), 4000);
      }
    };
    if (confirm) {
      confirm({
        title: L('pf_project_delete', 'Delete project…'),
        message: L('pf_project_delete_confirm', 'Conversations become Unassigned; workspace files are untouched.'),
        danger: true,
      }).then((ok) => { if (ok) void run(); }).catch(() => {});
      return;
    }
    if (window.confirm(L('pf_project_delete', 'Delete project…') + ' ' + project.name + '\n' + L('pf_project_delete_confirm', 'Conversations become Unassigned; workspace files are untouched.'))) void run();
  }

  /* ── HERMES.md via core file API ─────────────────────────────────────── */

  function hermesMdSession(project) {
    // core's file API is session-scoped; pick a visible non-read-only session
    // whose workspace is the project's bound workspace (prefer same project).
    const ws = projectBindings(project).workspace;
    if (!ws) return null;
    let best = null;
    for (const s of state.sessions) {
      if (isReadOnlySession(s) || s.workspace !== ws) continue;
      if (!best) best = s;
      if (s.project_id === project.project_id) { best = s; break; }
    }
    return best;
  }

  let mdDialog = null;

  function closeMdDialog() {
    if (!mdDialog) return;
    const prev = mdDialog.prevFocus;
    const pid = mdDialog.projectId;
    try {
      document.removeEventListener('keydown', mdDialog.onKey, true);
      mdDialog.overlay.remove();
    } catch (_) {}
    mdDialog = null;
    // Return focus to the opener (the project gear); never leave it on
    // <body> behind a just-closed modal.
    if (isFocusableNow(prev)) {
      try { prev.focus({ preventScroll: true }); return; } catch (_) {}
    }
    if (pid && focusPfk('gg:' + pid)) return;
    try {
      const tog = document.getElementById('pf-mode-toggle');
      if (isFocusableNow(tog)) tog.focus({ preventScroll: true });
    } catch (_) {}
  }

  function mdPathFor(ws) {
    // One absolute path for both the read and the save: core resolves it
    // against the session's CURRENT workspace and rejects it if that
    // workspace changed in between, instead of silently saving this text
    // into another workspace's HERMES.md (a relative "HERMES.md" would).
    return String(ws).replace(/[\\/]+$/, '') + '/HERMES.md';
  }

  function openHermesMdDialog(project) {
    if (mdDialog) closeMdDialog();
    const ws = projectBindings(project).workspace;
    if (!ws) { toast(L('pf_hermes_md_no_workspace', 'Set a workspace for this project first.')); return; }
    const s = hermesMdSession(project);
    if (!s) { toast(L('pf_hermes_md_no_session', 'Open or create a chat in the project workspace first.'), 5000); return; }
    const mdPath = mdPathFor(ws);
    const prevFocus = document.activeElement;
    const overlay = el('div', 'pf-overlay');
    const dlg = el('div', 'pf-dialog');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', L('pf_hermes_md', 'Project instructions (HERMES.md)…'));
    const head = el('div', 'pf-dialog-head');
    head.appendChild(el('div', 'pf-dialog-title', 'HERMES.md — ' + project.name));
    const x = el('button', 'pf-dialog-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', L('pf_close', 'Close'));
    x.title = x.getAttribute('aria-label');
    x.addEventListener('click', closeMdDialog);
    head.appendChild(x);
    const status = el('div', 'pf-dialog-text', L('pf_loading_file', 'Loading…'));
    status.setAttribute('aria-live', 'polite');
    const ta = el('textarea', 'pf-textarea');
    ta.spellcheck = false;
    ta.disabled = true;
    ta.setAttribute('aria-label', 'HERMES.md');
    const err = el('div', 'pf-dialog-err');
    err.setAttribute('role', 'alert');
    const row = el('div', 'pf-dialog-actions');
    const save = el('button', 'pf-btn pf-btn-primary', L('pf_save', 'Save'));
    save.type = 'button';
    save.disabled = true;
    let saving = false;
    save.addEventListener('click', async () => {
      if (saving || save.disabled) return;
      saving = true;
      // Never disable the focused button (that drops focus to <body>, where
      // core treats Enter as "Allow once"); mark it busy and freeze the text.
      save.setAttribute('aria-disabled', 'true');
      ta.readOnly = true;
      err.textContent = '';
      try {
        await apiPost('/api/file/save', { session_id: s.session_id, path: mdPath, content: ta.value });
        toast(L('pf_hermes_md_saved', 'HERMES.md saved'));
        if (mdDialog === me) closeMdDialog(); // never close a newer dialog
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (mdDialog !== me) {
          toast(L('pf_failed_to_save', 'HERMES.md save failed') + ': ' + msg, 5000);
        } else {
          err.textContent = msg;
        }
      } finally {
        saving = false;
        save.removeAttribute('aria-disabled');
        ta.readOnly = false;
      }
    });
    const cancel = el('button', 'pf-btn', L('cancel', 'Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', closeMdDialog);
    row.appendChild(cancel);
    row.appendChild(save);
    dlg.appendChild(head);
    dlg.appendChild(status);
    dlg.appendChild(ta);
    dlg.appendChild(err);
    dlg.appendChild(row);
    overlay.appendChild(dlg);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeMdDialog(); });
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMdDialog(); } };
    document.addEventListener('keydown', onKey, true);
    // lightweight Tab containment: aria-modal without a trap is a lie
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      let focusables = [];
      try {
        focusables = Array.prototype.filter.call(
          dlg.querySelectorAll('button, textarea, input, [href]'),
          (n) => !n.disabled
        );
      } catch (_) { return; }
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dlg.contains(active))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (active === last || !dlg.contains(active))) {
        e.preventDefault(); first.focus();
      }
    });
    document.body.appendChild(overlay);
    const me = { overlay, onKey, prevFocus, projectId: project.project_id };
    mdDialog = me;
    // The textarea is disabled until the read lands; start on an enabled
    // control so focus is inside the modal from the first frame.
    try { cancel.focus({ preventScroll: true }); } catch (_) {}

    // Save stays disabled until a successful read, so a failed load can
    // never blank an existing file.
    void (async () => {
      try {
        const d = await apiGet('/api/file?session_id=' + encodeURIComponent(s.session_id) + '&path=' + encodeURIComponent(mdPath));
        if (mdDialog !== me) return; // closed meanwhile
        ta.value = (d && typeof d.content === 'string') ? d.content : '';
        ta.disabled = false;
        save.disabled = false;
        status.textContent = 'HERMES.md · ' + Lf('pf_bytes', '{0} bytes', (d && d.size != null ? d.size : ta.value.length)) + ' · ' + mdPath;
        try { ta.focus({ preventScroll: true }); } catch (_) {}
      } catch (e) {
        if (mdDialog !== me) return;
        ta.disabled = true;
        save.disabled = true;
        const msg = (e && e.message) || String(e);
        // core answers 404 for a missing file AND for other refusals (too
        // large, outside the workspace); only the former is "no file yet"
        if (e && e.status === 404 && /^(Not a file|File not found)/i.test(msg)) {
          status.textContent = L('pf_hermes_md_missing', 'No HERMES.md yet.');
        } else {
          status.textContent = L('pf_failed_to_load', 'Failed to load') + ': ' + msg;
        }
      }
    })();
  }

  /* ── boot ────────────────────────────────────────────────────────────── */

  function boot() {
    if (state.ready) return;
    state.ready = true;
    state.collapsed = lsGetObj(LS.collapse, {});
    state.mode = lsGet(LS.mode, 'folders') === 'classic' ? 'classic' : 'folders';
    checkCompatibility();
    try {
      buildDom();
    } catch (err) {
      console.error('[' + EXT_ID + '] DOM init failed; staying out of the way', err);
      state.ready = false;
      return;
    }
    applyMode();
    void runRefresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0), { once: true });
  } else {
    setTimeout(boot, 0);
  }

  // Minimal, read-mostly test/debug surface (no side effects on load).
  window.__PF__ = {
    state,
    runRefresh,
    requestRefresh,
    render,
    newChatInProject,
    openSessionRow,
    snapshotHash,
  };
})();
