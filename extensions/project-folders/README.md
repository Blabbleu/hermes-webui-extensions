# Project Folders

Collapsible **project folders** for the Hermes WebUI chat sidebar: chats are
grouped by their core `project_id`, each folder collapses, paginates, and
offers per-project quick actions. The reworked v2 is a **client-side-only**
extension — no sidecar, no systemd unit, no filesystem or external-network
permissions. Every server-side behavior goes through stock core WebUI APIs.

Toggle it with the **folder icon next to the "+"** in the Chat panel header
(Folders ⇄ Classic). The choice persists in browser storage.

## What it does

- **Folders in the sidebar** — one group per core project (in core's project
  order, with the project color dot), plus an **Unassigned** group. Sessions
  whose `project_id` is unknown (deleted or cross-profile project) fall back
  to Unassigned instead of disappearing.
- **New chat in a project** — creates the session through core's
  `newSession(false, { project_id, workspace, model, model_provider })`,
  forwarding the project's **core bindings** (`/api/projects` data). Core
  skips its own binding merge when `project_id` is passed explicitly, so the
  extension forwards the bindings itself; behavior matches core's project
  quick-create. "New chat" under Unassigned sends an explicit
  `project_id: null` (so core's active-project filter cannot re-file it) and
  honors core's empty-chat reuse guard (#1171) instead of minting duplicates.
- **Open a chat** — goes through core's `_openSidebarSession()`, so the
  mobile drawer closes, extension session-open hooks run, and profile
  handling behaves exactly like the classic list.
- **Row menu** — Move to project / Unassign, Rename, **Regenerate title**
  (core's `POST /api/session/title/regenerate` with `prefer_latest: true`
  and the user's configured title model — the same endpoint core's own menu
  uses, with a client-side abort past the proxy timeout), *Use project
  workspace* (explicit, confirmed), Archive, Delete. Deleting or archiving
  the **open** chat moves the UI to the most recent remaining conversation,
  like core does. Rendered with core's own session-action menu builder when
  available (a11y + styling parity).
- **Project menu (⚙)** — New chat here, Set/Change/Unbind workspace via
  **core's** `POST /api/projects/bind` (the binding is core project state —
  shared with core's quick-create and visible to `/api/projects`),
  Project instructions (HERMES.md), Rename project, Delete project.
- **HERMES.md** — read via `GET /api/file` and saved via
  `POST /api/file/save` against a session in the project's bound workspace.
  Core enforces path safety (`O_NOFOLLOW`, symlink rejection), preserves file
  modes, and caps reads. **Save stays disabled until a successful read**, so
  a failed load can never blank an existing file.
- **Drag & drop** (desktop) — drag a row onto a folder header to move it
  (`/api/session/move`). Moving never rewrites the session's workspace; the
  explicit *Use project workspace* menu item is the deliberate path.
- **Sidebar stays sane** — `#pf-folders` is inserted *before* `#sessionList`
  so core's search box stays on top; the folder list follows core's search
  input, including core's clear button and Escape (which set the value
  programmatically without an `input` event) and any boot/restore rewrite
  (re-synced on every data refresh). Folder filtering matches title and
  session id; core's deep content search belongs to the classic list.
- **Refresh without churn** — no second `EventSource`. The extension wraps
  core's exported `window.refreshSessionList` (pass-through) so core's own
  SSE-driven refreshes also refresh the folder view, plus a 30 s poll that
  pauses on hidden tabs. Repaints are skipped when a snapshot hash is
  unchanged; otherwise rows are reconciled by `session_id` and keyboard
  focus is restored to the same control. While a fetch is in flight, exactly
  one follow-up refresh is queued.

## Keyboard, touch, and active chat

- Rows, folder headers, "+ New chat", pagers, and all menu items are real
  `<button>`s (native Enter/Space). Group actions and row actions reveal on
  `:focus-within` as well as hover; on coarse pointers they are always
  visible (opacity-based, so no touch-cascade collapse is possible).
- On phone widths (≤ 640 px, matching core's own rule) rows and controls
  meet core's 44 px minimum.
- The open chat's row is highlighted (`aria-current="page"`) and stays
  visible when it sorts just below the pagination window (the window extends
  up to 15 rows; further down, "Show more" reaches it).

## Out of scope (intentional)

Folders mode replaces only the **list**; the classic sidebar keeps owning:

- **Archived sessions** — not rendered in folders (the core classic list and
  its archived paging own them). Archiving from a row menu therefore moves
  the chat out of the folder view; un-archive it in Classic mode.
- **Select mode / batch bar, WebUI/CLI source tabs, unread indicators,
  lineage/child session rows, project chips** — these stay in Classic.
  Toggle the header icon off to reach them. The folder view follows core's
  current WebUI/CLI source tab and all-profiles switch when loading its
  list, and excludes core's `default_hidden` rows (`exclude_hidden=1`).
- **Creating a missing HERMES.md** — core's `/api/file/save` refuses to
  create files that do not exist (404). The dialog edits an existing
  `HERMES.md` in the project workspace; to create one, ask the agent in a
  project chat or create the file yourself, then reopen the dialog. The
  HERMES.md item is disabled until a visible session exists in the bound
  workspace, because core's file API is session-scoped.

## Trust model

- **No sidecar, no native host, no external network.** All traffic is
  same-origin WebUI APIs, declared in `extension.json`.
- **No arbitrary filesystem access.** HERMES.md goes through core's
  path-safe file API (workspace-anchored, symlink-rejecting).
- Project/workspace bindings written by this extension are **core state**
  (`/api/projects/bind`), not extension state; uninstalling the extension
  leaves core projects and their bindings intact.
- Cosmetic state (`hermes-pf-mode`, `hermes-pf-collapse`) lives in browser
  localStorage under extension-owned keys.
- Labels route through core's `t()` i18n with English fallbacks.

## Install / disable / uninstall

- **Install**: Settings → Extensions → install from the registry; the folder
  sidebar activates on next page load. No restart, no extra services.
- **Disable**: click the header icon (folders → classic), or disable the
  extension in Settings → Extensions. Disabling never touches core projects.
- **Uninstall**: remove in Settings → Extensions. Nothing else to clean up;
  browser storage keys are inert afterwards.

## Compatibility

Tested against core WebUI `77c8fc174` (`exp-v0.52.515`, `static/sessions.js`,
`static/boot.js`, `static/ui.js`, `api/routes.py` read at that revision).
The extension degrades gracefully: if expected core hooks are missing it
never engages folders mode at all (core's list stays exactly as shipped)
and shows a hint only inside its own inert container.

## Related: the full local variant

Users who need **HERMES.md creation/standalone editing without a session**,
or **standalone title generation via their own OpenAI-compatible endpoint**,
can use the maintained full variant (sidecar-based, outside this registry):
[motolight/hermes-webui-project-folders](https://github.com/motolight/hermes-webui-project-folders).
Project→workspace chat assignments survive switching between the variants:
the lite variant reads and writes core's own project bindings, and the
full variant's own state file is never touched by the lite one.
