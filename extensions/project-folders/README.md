# Project Folders

Collapsible **project folders** for the Hermes WebUI chat sidebar, plus
**regenerate-title-from-context** and per-project **workspace + `HERMES.md`**
management — backed by a token-v1 loopback sidecar.

Author: `motolight`.

## What it does

- Turns the existing Projects (the `project_id` on sessions) into a collapsible
  folder sidebar inside the chat panel: one group per project, with a
  project-colored dot, session count, per-project **"New chat"**, and a
  **"Show more / Show less"** pagination window (5 rows per group by default).
- Row actions: move between projects (or to *Unassigned*), rename, archive /
  unarchive, delete, **"Regenerate title from context"**, and — when the
  session's workspace differs from the project workspace — **"Use project
  workspace"**. Drag a session row onto a group header to move it.
- **Project workspaces**: bind a project to a folder on disk. New chats created
  from that project's "+ New chat" start in the bound workspace atomically
  (`project_id` + `workspace` in one `POST /api/session/new`). The sidecar
  validates every workspace path before use (must be under the user's home,
  under the WebUI default workspace, or in the WebUI saved-workspaces list;
  system roots are always rejected).
- **`HERMES.md` editing**: view/edit the project instructions file inside the
  bound workspace, with a starter template. This is the file WebUI loads into
  the agent context for that workspace.
- **Regenerate title from context**: sends a trimmed, most-recent tail of the
  conversation (max ~9 000 chars) to a user-configured OpenAI-compatible
  endpoint and applies the returned title through the stock rename API.
- A **Folders / Classic** toggle switches back to the stock session list at any
  time; the core list is only hidden via a body CSS class, never mutated.

## Who it is for

Users who run many conversations across several projects and want the sidebar
grouped by project, with the project's working folder and `HERMES.md` context
managed from the chat UI instead of the terminal.

## Installation

1. **Settings → Extensions**, install **Project Folders** from the registry.
   The WebUI itself does not need a restart (`webui_restart_required: false`).
2. Install and start the bundled sidecar (the runtime is vendored in
   [`sidecar/`](sidecar/); stdlib-only `python3`, no pip dependencies):

   ```bash
   mkdir -p ~/.config/systemd/user
   cp ~/.hermes/webui/extensions/project-folders/sidecar/project-folders-sidecar.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now project-folders-sidecar
   ```

3. In **Settings → Extensions**, approve the sidecar proxy consent for
   `project-folders`. WebUI mints the `token-v1` secret and the scaffold
   reads it per request. WebUI authentication must be enabled
   (Settings → Password) — with auth off, the proxy fails closed and the
   workspace features stay disabled.

Without the sidecar the folder sidebar still works (it is pure WebUI data);
workspace binding, `HERMES.md` editing, and title regeneration are paused with
a toast explaining why.

## Disabling and uninstalling

- **Disable mode temporarily**: the *Sidebar: Folders / Classic* toggle at the
  top of the folder list (persisted in `hermes-pf-mode`).
- **Disable the extension**: Settings → Extensions → disable. The extension
  stops injecting; the core session list returns.
- **Uninstall**: Settings → Extensions → uninstall, then stop and remove the
  sidecar unit and its state:

  ```bash
  systemctl --user disable --now project-folders-sidecar
  rm ~/.config/systemd/user/project-folders-sidecar.service
  rm -rf ~/.hermes/webui/extensions/project-folders
  ```

  The sidecar only stores its own bindings file (`state/project-workspaces.json`
  under the extension directory) and reads/writes `HERMES.md` files you edited
  inside your workspaces. It never writes into WebUI core state; project and
  session data itself lives in WebUI and is untouched.

## WebUI APIs and DOM surfaces used

- **Reads** (same-origin, absolute `/api/...`): `/api/projects`,
  `/api/sessions`, `/api/sessions/events` (SSE refresh signal),
  `/api/session` (single session with messages, for title regeneration).
- **Writes**: `/api/session/new|move|update|rename|archive|delete`,
  `/api/projects/rename`, `/api/projects/delete` — all stock endpoints; the
  extension adds no core routes.
- **Sidecar proxy paths**: everything under
  `/api/extensions/project-folders/sidecar/v1/...`.
- **Navigation**: uses `window.loadSession` / `window.newSession` when present
  and falls back to `/session/<id>` URL navigation (`webui_navigation: true`).
- **DOM**: additive only — one `#pf-folders` container inserted into
  `#panelChat`, next to `#sessionSearch` / `#sessionList`. The core list is
  hidden with a `body.pf-mode-folders` CSS rule, never removed. Expected hooks
  (`#sessionList`, `#panelChat`, `loadSession()`) are feature-checked; if a
  future WebUI removes them the extension renders an "inactive" notice instead
  of breaking the page.
- **Storage**: owns `hermes-pf-mode` and `hermes-pf-collapse` in browser
  storage (via `hermesExt` settings when available, localStorage fallback).

## Trust model and permissions

Extensions run as trusted local code in the WebUI origin against your
authenticated session. This entry's declared permissions (see
[`extension.json`](extension.json)):

- `loopback_sidecar: true` — the sidecar listens on `127.0.0.1:17872` only;
  no other network exposure.
- `proxy_auth: token-v1` — every route except `/health` requires the
  WebUI-injected `X-Hermes-Sidecar-Token`; missing token file → 503, wrong
  token → 401, both fail closed. Honest scope: the token keeps callers that
  cannot read the user's WebUI state dir off the loopback port; it does **not**
  defend against arbitrary code running as the same user (such code can read
  the token file directly).
- `filesystem.arbitrary: true` — the sidecar reads `workspaces.json` /
  `settings.json` from the WebUI state dir (read-only, for workspace
  validation) and reads/writes **only `HERMES.md`** inside workspaces that pass
  the validation above (under home, under the default workspace, or in the
  saved-workspaces list; system roots and paths outside those rules are
  rejected). Bindings state is written to the extension's own `state/` dir.
- `network_external: true` — title regeneration makes exactly one HTTP call per
  action to the **user-configured** endpoint (default
  `http://127.0.0.1:8000/v1`, an OpenAI-compatible server on your own
  machine). **Privacy: the conversation tail is sent only to that endpoint you
  configure yourself; there is no telemetry and no other outbound network use.**
  Do not point `PF_LLM_BASE_URL` at a third-party service unless you intend to
  send conversation text there.
- No remote third-party scripts are loaded at runtime; all assets ship with
  this entry.

## Sidecar behavior

- **Starts/stops** via the systemd user unit
  [`sidecar/project-folders-sidecar.service`](sidecar/project-folders-sidecar.service)
  (`systemctl --user enable --now project-folders-sidecar`).
- **Host/port**: `127.0.0.1:17872` (bound to IPv4 loopback only; the scaffold
  owns the dispatch loop — the entry ships no other server).
- **Auth**: canonical scaffold (byte-identical `sidecar_base.py` /
  `sidecar.py`), token resolved per request from
  `$HERMES_EXT_SIDECAR_TOKEN_FILE` → `$HERMES_WEBUI_STATE_DIR/sidecar-auth/project-folders.token`
  → `$HERMES_HOME/webui/sidecar-auth/project-folders.token` → platform default.
- **Files**: writes `HERMES.md` inside validated workspaces and
  `state/project-workspaces.json` in its own directory; reads the WebUI
  state-dir workspace list. Bounded sizes: 200 KiB per `HERMES.md`, 512 KiB
  per request body.
- **Title regeneration config** (env on the sidecar process; no secrets are
  stored in the unit — use `systemctl --user edit project-folders-sidecar`):

  | Variable | Default | Meaning |
  |---|---|---|
  | `PF_LLM_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible endpoint (vLLM, llama.cpp server, Ollama's `/v1`, …) |
  | `PF_LLM_MODEL` | *(unset)* | model id; when unset the first id from the endpoint's `/models` is used |
  | `PF_LLM_TIMEOUT_S` | `60` | LLM request timeout (see the proxy-timeout limitation below) |

- **Runs without modifying Hermes WebUI core.** If the WebUI extension/sidecar
  proxy contract changes (proxy path shape, token header, state-dir layout),
  the sidecar's proxied routes stop with 4xx/5xx and the extension falls back
  to passive mode — nothing else in the WebUI breaks.
- **Docker**: sidecars are not supported with bridge-networked WebUI
  containers (loopback is namespace-local); core and sidecar must share a
  network namespace and the state dir.

## Known limitations

- The sidecar proxy buffers responses with a **~10 s upstream timeout** and no
  streaming. A title request to a slow (especially remote) endpoint can exceed
  it and surface as a proxy error even if the sidecar later succeeds. For
  non-local endpoints set `PF_LLM_TIMEOUT_S=8` (or run a local model) so the
  request finishes inside the window.
- `HERMES.md` changes take effect on the agent side according to WebUI's own
  context-reload behavior; the extension does not force a context refresh.
- Group pagination resets on page reload by design (it is display-only state).
- Drag-and-drop move is enabled only on fine-pointer devices.

## Compatibility and verification notes

- Tested against the Hermes WebUI extension API surface described in
  [`docs/extension-entry.md`](../../docs/extension-entry.md) (manifest bundle +
  loopback sidecar metadata) and the token-v1 contract in
  [`docs/SIDECAR_CONTRACT.md`](../../docs/SIDECAR_CONTRACT.md). The entry was
  verified with `node scripts/validate-extensions.mjs`,
  `node scripts/scan-extension-safety.mjs`, `node scripts/sync-sidecar-base.mjs
  --check`, `node scripts/check-sidecar-usage.mjs`, and a local sidecar smoke
  test (health without token → 200; routes without/with wrong token → 401;
  missing token file → 503; valid token → 200 on `/v1/state`,
  `/v1/bindings`, `/v1/hermes-md`).
- DOM surfaces used: `#panelChat`, `#sessionList`, `#sessionSearch`, and the
  optional globals `loadSession`, `newSession`, `showToast`, `S`.
