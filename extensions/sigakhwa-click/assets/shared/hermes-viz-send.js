/*
 * hermes-viz-send.js — window.HermesVizSend v1 (README: Safety rules of the send path). Owner: A (sigakhwa-click).
 *
 * The ONLY way text reaches the model through this module is core's own global `send()` — the same
 * function the Enter key calls (static/messages.js:1384) — after the text has been placed in the
 * composer textarea `#msg` and an `input` event has been dispatched. The module never calls any
 * /api endpoint itself, refuses when local state reports a running turn, and never sends without a
 * user gesture upstream (callers only invoke send() from click handlers).
 *
 * Plain classic script, idempotent (safe to inject twice), never throws at load time when core
 * globals are missing: every core lookup is lazy and guarded. Core globals used (verified against
 * the pinned upstream, see README: WebUI surfaces used):
 *   S (ui.js:8)             — S.session.session_id, S.activeProfile, S.busy, S.activeStreamId, S.pendingFiles
 *   $ (ui.js)               — $('msg') composer textarea
 *   send (messages.js:1384) — core send path; _sendInProgress (messages.js:1190) in-flight guard
 *   isCompressionUiRunning (ui.js:16275) — core's send() treats a running manual compression as
 *                             busy (messages.js:1438-1441) and would QUEUE; mirrored here as a refusal
 *   showToast (ui.js:9661)  — localized toasts for every refusal
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.HermesVizSend && window.HermesVizSend.version >= 1) return;

  var VERSION = 1;
  var MAX_TEXT = 2000;
  var DUPLICATE_WINDOW_MS = 2000;
  var INFLIGHT_TIMEOUT_MS = 20000;
  var EVENT_NAME = 'hermes-viz:send';

  var MESSAGES = {
    ko: {
      empty: '보낼 내용이 없습니다',
      too_long: '질문이 너무 깁니다 (최대 ' + MAX_TEXT + '자)',
      no_session: '열려 있는 대화가 없습니다 — 대화를 먼저 열어 주세요',
      stale_session: '이 그림은 다른 대화의 것입니다 — 새로고침 후 다시 시도하세요',
      stale_profile: '이 그림은 다른 프로필에서 만든 것입니다 — 프로필을 확인한 뒤 다시 시도하세요',
      busy: '답변 생성 중에는 보낼 수 없습니다',
      locked: '지금은 입력창을 사용할 수 없습니다 (편집 중·첨부 대기·읽기 전용)',
      duplicate: '같은 질문을 방금 보냈습니다',
      core_missing: 'WebUI 전송 기능을 찾을 수 없습니다 — 페이지를 새로고침해 주세요',
      send_failed: '전송에 실패했습니다 — 다시 시도해 주세요',
      slash_command: '슬래시(/) 명령은 그림에서 보낼 수 없습니다',
      draft_present: '입력창의 초안을 먼저 보내거나 지워 주세요'
    },
    en: {
      empty: 'There is nothing to send',
      too_long: 'The question is too long (maximum 2000 characters)',
      no_session: 'Open a conversation first',
      stale_session: 'This diagram belongs to another conversation — refresh and try again',
      stale_profile: 'This diagram belongs to another profile — check your profile and try again',
      busy: 'Cannot send while a reply is being generated',
      locked: 'The composer is unavailable (editing, pending attachments, or read-only)',
      duplicate: 'You just sent the same question',
      core_missing: 'WebUI send is unavailable — refresh the page',
      send_failed: 'Sending failed — try again',
      slash_command: 'Slash (/) commands cannot be sent from diagrams',
      draft_present: 'Send or clear your draft first'
    }
  };
  function t(key) {
    var lang = typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : '';
    return MESSAGES[String(lang || '').toLowerCase().indexOf('ko') === 0 ? 'ko' : 'en'][key];
  }

  var inflight = null;                 // Promise while a send is running (one at a time)
  var lastSent = { key: '', at: 0 };   // duplicate window keyed by (sessionId, text)

  // ── lazy, guarded core lookups ───────────────────────────────────────────
  function coreState() {
    try { if (typeof S !== 'undefined' && S && typeof S === 'object') return S; } catch (_) {}
    return (window.S && typeof window.S === 'object') ? window.S : null;
  }
  function byId(id) {
    try { if (typeof $ === 'function') { var el = $(id); if (el) return el; } } catch (_) {}
    try { if (typeof document !== 'undefined' && document && document.getElementById) return document.getElementById(id); } catch (_) {}
    return null;
  }
  function coreSend() {
    try { if (typeof send === 'function') return send; } catch (_) {}
    return typeof window.send === 'function' ? window.send : null;
  }
  function coreSendInProgress() {
    try { if (typeof _sendInProgress !== 'undefined') return !!_sendInProgress; } catch (_) {}
    return false;
  }
  function coreCompressionRunning() {
    try { if (typeof isCompressionUiRunning === 'function') return !!isCompressionUiRunning(); } catch (_) {}
    try { if (typeof window.isCompressionUiRunning === 'function') return !!window.isCompressionUiRunning(); } catch (_) {}
    return false;
  }
  // Core-busy predicate, mirroring send()'s own `S.busy || compressionRunning` plus the stream id.
  function coreBusy(st) {
    if (st && (st.busy || st.activeStreamId)) return true;
    return coreCompressionRunning();
  }
  function toast(msg, ms, type) {
    try { if (typeof showToast === 'function') { showToast(msg, ms, type); return; } } catch (_) {}
    try { if (typeof window.showToast === 'function') window.showToast(msg, ms, type); } catch (_) {}
  }
  function hasInlineEdit() {
    try { return !!(typeof document !== 'undefined' && document.querySelector && document.querySelector('.msg-edit-area')); } catch (_) { return false; }
  }
  function hasPendingAttachments(st) {
    try { if (st && Array.isArray(st.pendingFiles) && st.pendingFiles.length) return true; } catch (_) {}
    try { if (typeof window._hasPendingSelections === 'function' && window._hasPendingSelections()) return true; } catch (_) {}
    return false;
  }
  function dispatchInput(el) {
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {
      try { var ev = document.createEvent('Event'); ev.initEvent('input', true, false); el.dispatchEvent(ev); } catch (_e) {}
    }
  }
  function emit(source, ok, reason, text) {
    try {
      if (typeof CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
      var detail = { source: source, ok: !!ok, textPreview: String(text || '').slice(0, 80) };
      if (!ok) detail.reason = reason;
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: detail }));
    } catch (_) {}
  }

  // ── public: target + busy ────────────────────────────────────────────────
  function currentTarget() {
    var st = coreState();
    var sid = st && st.session && st.session.session_id;
    if (!sid) return null;
    return { sessionId: String(sid), profile: String(st.activeProfile || 'default') };
  }

  function isBusy() {
    var st = coreState();
    if (coreBusy(st)) return true;
    var msg = byId('msg');
    if (msg && msg.disabled) return true;
    if (hasInlineEdit()) return true;
    if (coreSendInProgress()) return true;
    return !!inflight;
  }

  // ── public: send ─────────────────────────────────────────────────────────
  function refuse(reason, source, text) {
    var ms = reason === 'duplicate' ? 1500 : 3200;
    var type = (reason === 'core_missing' || reason === 'send_failed') ? 'error' : (reason === 'duplicate' ? 'info' : 'warning');
    toast(t(reason) || t('send_failed'), ms, type);
    emit(source, false, reason, text);
    return Promise.resolve({ ok: false, reason: reason });
  }

  function sendText(opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var source = (typeof o.source === 'string' && o.source) ? o.source.slice(0, 40) : 'unknown';
    var text = typeof o.text === 'string' ? o.text.trim() : '';
    var bound = (o.bound && typeof o.bound === 'object') ? o.bound : null;

    if (!text) return refuse('empty', source, text);
    if (text.length > MAX_TEXT) return refuse('too_long', source, text);
    // Hardening beyond the frozen contract: a leading "/" would be interpreted by core's send()
    // as a local slash command (/terminal, /stop, ...). Model-influenced text must never reach
    // that surface, so it is refused here (additive reason, recorded as a contract deviation).
    if (text.charAt(0) === '/') return refuse('slash_command', source, text);

    var doSend = coreSend();
    var msg = byId('msg');
    if (!doSend || !msg) return refuse('core_missing', source, text);

    var target = currentTarget();
    if (!target) return refuse('no_session', source, text);
    // `bound` was captured at render time; it must still describe the visible conversation.
    if (!bound || String(bound.sessionId || '') !== target.sessionId) return refuse('stale_session', source, text);
    if (String(bound.profile || 'default') !== target.profile) return refuse('stale_profile', source, text);

    var st = coreState();
    if (coreBusy(st) || coreSendInProgress() || inflight) return refuse('busy', source, text);
    if (msg.disabled || hasInlineEdit()) return refuse('locked', source, text);
    if (st && st.session && (st.session.read_only || st.session.is_read_only)) return refuse('locked', source, text);
    // Staged files / context blocks would be attached to OUR message by core's send(); refuse
    // instead of hijacking the user's pending attachments.
    if (hasPendingAttachments(st)) return refuse('locked', source, text);

    if (String(msg.value || '')) return refuse('draft_present', source, text);

    // Session ids never contain a newline, so (sessionId, text) is unambiguous with "\n".
    var key = target.sessionId + '\n' + text;
    var now = Date.now();
    if (lastSent.key === key && (now - lastSent.at) < DUPLICATE_WINDOW_MS) return refuse('duplicate', source, text);

    var run = performSend(doSend, msg, text, source, key, now);
    inflight = run;
    var release = function () { if (inflight === run) inflight = null; };
    run.then(release, release);
    return run;
  }

  function performSend(doSend, msg, text, source, key, startedAt) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(ok, reason) {
        if (settled) return;
        settled = true;
        if (ok) {
          // The duplicate window is armed only by a send core actually accepted, so a retry after
          // send_failed / timeout is never refused as 'duplicate'.
          lastSent = { key: key, at: startedAt };
          emit(source, true, undefined, text);
          resolve({ ok: true });
        } else {
          toast(t(reason) || t('send_failed'), 3200, 'error');
          emit(source, false, reason, text);
          resolve({ ok: false, reason: reason });
        }
      }
      var timer = setTimeout(function () { finish(false, 'send_failed'); }, INFLIGHT_TIMEOUT_MS);
      try {
        msg.value = text;
        dispatchInput(msg);
        var p = doSend();                     // exactly the Enter path: core send() with no arguments
        Promise.resolve(p).then(function () {
          clearTimeout(timer);
          // Core clears the composer the moment it accepts the text. If our text is still there,
          // core refused silently (read-only session, recovery hint, ...): report send_failed.
          var accepted = String(msg.value || '') !== text;
          finish(accepted, accepted ? undefined : 'send_failed');
        }, function () {
          clearTimeout(timer);
          finish(false, 'send_failed');
        });
      } catch (_) {
        clearTimeout(timer);
        finish(false, 'send_failed');
      }
    });
  }

  window.HermesVizSend = Object.freeze({
    version: VERSION,
    currentTarget: currentTarget,
    isBusy: isBusy,
    send: sendText,
    MESSAGES: Object.freeze(Object.assign({}, MESSAGES))
  });
})();
