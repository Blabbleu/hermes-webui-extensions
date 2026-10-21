# btop

A [btop](https://github.com/aristocratos/btop)-style system monitor as its own
Hermes WebUI page. It adds a monitor icon to the nav rail (and the phone nav).
Clicking it opens a full-width page beside Chat, Insights and Logs.

It is for people who self-host Hermes and want to see, without opening a
terminal, what the box is doing and how much of it Hermes itself is using.

## What it shows

| Box | Contents |
|---|---|
| **1 cpu** | Dotted (or area) usage graph, total meter, per-core meters with mini-graphs and temperatures, load average, user/sys/iowait/steal split, task counts, uptime |
| **2 mem** | Used / available / cached / free / swap meters and a usage graph |
| **3 net** | Download and upload graphs for one interface (‹ › switches interface), current rate in bits, peak, totals |
| **4 disks** | Each real filesystem: used/total, read/write rate, busy %, I/O sparklines |
| **5 hermes** | Hermes processes grouped as `agent`, `webui`, `cron`, `mcp`, `swe-pilot`, `browser`, `coding-cli`, `btop`. Children inherit their parent's group. Tap a group to filter the process table |
| **6 proc** | Sortable process table with CPU sparklines, filter, tree view (collapsible), and a detail pane (cwd, exe, fds, I/O, context switches, children) with TERM / INT / HUP / KILL / STOP / CONT, each needing a confirm tap |

**Filter syntax:** space-separated terms are ANDed. A term matches name,
command, pid, user or group. `g:webui` matches one group, `g:*` matches any
Hermes group, and `!term` negates a term.

**Keys** (while the page is open and focus is not in an input):
- `1`–`6` toggle boxes.
- `f` or `/` filters; `t` toggles tree view.
- `c` `m` `p` `n` sort by cpu / mem / pid / name; `r` reverses the sort.
- `↑` `↓` select a process; `Esc` closes the detail pane or clears the filter; `space` pauses.

**Settings** (Settings → Extensions → btop):
- Refresh interval (250–10000 ms, default 1000).
- Graph style: dots or area.
- Process CPU% per core instead of as a share of all cores.

Box visibility, sort, tree mode, filter and interface are remembered in
extension-owned browser storage.

The page uses only core CSS tokens, so it follows the active skin and
light/dark theme. Below 860 px it stacks into one column; below 640 px the
command column and sparklines are hidden for phones.

## Install

1. Install from **Settings → Extensions** (gallery), or from a checkout:
   `python3 scripts/install.py` copies the entry into
   `~/.hermes/webui/extensions/btop/` and registers it.
2. Start the sidecar. Pick one:
   - **User unit.** It sees every process and can signal only your own:
     ```bash
     cp ~/.hermes/webui/extensions/btop/sidecar/hermes-btop-sidecar.service ~/.config/systemd/user/
     systemctl --user enable --now hermes-btop-sidecar
     ```
   - **System unit as root.** It can signal any process:
     `python3 scripts/install.py --service`.
   - **By hand:** `cd ~/.hermes/webui/extensions/btop/sidecar && python3 -S sidecar.py`
3. Open **Settings → Extensions → Diagnostics → Loopback sidecars**. On the
   **btop** row, click **Approve proxy consent**.
4. Reload the WebUI tab and click the monitor icon in the rail.

WebUI authentication must be on: core refuses token-v1 sidecar proxying when
auth is off.

## Disable / uninstall

- **Disable:** toggle btop off in Settings → Extensions → Installed, then
  reload. The sidecar can keep running; nothing calls it.
- **Uninstall:** remove it in Settings → Extensions, or run
  `python3 scripts/install.py --uninstall [--service]`. Then stop the
  sidecar: `systemctl --user disable --now hermes-btop-sidecar`, or
  `systemctl disable --now hermes-btop-sidecar` for the root unit.
- **Browser state:** stored prefs live under the extension's own storage
  namespace. Clear them from the extension's settings card.

## Sidecar

- **Listener:** `127.0.0.1:17797` only. Built on the canonical scaffold
  (`sidecar_base.py`, `sidecar.py`). Stdlib only, run with `python3 -S`.
- **Auth:** `proxy_auth: token-v1`. Every route except `GET /health` requires
  the token WebUI injects through its proxy (`/api/extensions/btop/sidecar/...`).
- **Sampling:** a background thread samples `/proc` and `/sys` every second
  and keeps 600 samples (10 min) of history. The page fetches only the delta
  since its last sequence number. Typical responses are 15–40 KB, capped at
  600 process rows to stay under the proxy's 512 KiB limit. Per-process
  sampling pauses when no page has polled for 30 s.
- **Routes:**
  - `GET /api/snapshot?since=&boot=`
  - `GET /api/proc/{pid}`
  - `POST /api/proc/{pid}/signal {"signal": "TERM"}`
- **Signals:** only TERM, INT, HUP, KILL, STOP and CONT are accepted. The
  sidecar refuses pid ≤ 1 and its own pid. Set `BTOP_SIGNALS=0` to turn signals
  off entirely; the page then hides the buttons.
- **Files:** reads `/proc`, `/sys/class/hwmon`, `/etc/os-release` and the
  token file. It writes nothing.

## Trust model and permissions

Like every extension, the page script runs with your WebUI session's authority.
It talks only to the same-origin sidecar proxy and makes no external network
calls.

The sidecar exposes host-wide process information to anyone who can use your
WebUI. That includes command lines and working directories of every user's
processes, including root's when the sidecar runs as root. Command lines are
passed through a secret mask before leaving the sidecar: URL credentials,
`Bearer` tokens, `--token`/`--password`/`api_key`-style flags and values, and
`sk-`, `ghp_`, `xox*-`, `AKIA` and JWT shapes are replaced. The mask is a
best-effort pattern list, not a guarantee.

Signals act with the sidecar's privileges. Run it as an unprivileged user unit
or set `BTOP_SIGNALS=0` if that's too much.

The extension owns its DOM. It adds a rail button, a mobile nav button, a
sidebar `.panel-view[data-panel-token="btop"]` and `#mainBtop` inside
`<main>`. It wraps `window.switchPanel` and `window.newSession` so leaving the
page restores core views.

## WebUI surfaces used

- Manifest bundle, extension-owned `settings_schema` and storage, and
  `hermesExt.register`.
- Token-v1 sidecar proxy.
- DOM: `.rail`, `.rail-spacer`, `.sidebar-nav`, `main.main`, `#mainChat`, and
  the `showing-x-<token>` + `data-panel-token` convention that core's mobile
  sidebar sync recognises.
- Core page globals, when present: `switchPanel`, `_currentPanel`,
  `_isDesktopWidth`, `_isSidebarCollapsed`, `expandSidebar`, `toggleSidebar`,
  `closeMobileSidebar`, `_beforePanelSwitch`, `showToast`,
  `switchSettingsSection`.

A WebUI refactor of the rail, `switchPanel` or the main-view classes may need
an update here.

## Known limitations

- **Linux only.** The sidecar reads procfs.
- **Containers.** Inside LXC with lxcfs, CPU/memory/load reflect the
  container, but temperatures and disk devices come from the host.
- **Disk I/O** is matched by block device name. Filesystems on loop or
  overlay devices may show no rate.
- **Process CPU%** is computed between the sidecar's 1 s samples. Very short
  processes may not appear.
- **Hermes groups** are pattern-based (command-line regexes), so renamed or
  wrapped launchers may land in no group.

## Compatibility and verification

- **Tested against:** Hermes WebUI v0.52.458 (`fd0141fa`, 2026-10-10) on
  Debian 13 (LXC, Python 3.13 for the sidecar); Chromium at 1440×900 and at 390×844 (mobile emulation).
- **Requires:** manifest bundles, `settings_schema`, `hermesExt.register`, and
  the token-v1 sidecar proxy.
- **Tests:**
  - `scripts/test-btop-core.mjs`: formatting, history merge, sort, filter
    grammar, process tree.
  - `scripts/test-btop-collector.py`: procfs parsers, CPU math, secret
    masking, Hermes grouping, a live snapshot, signal guards.
