"""Route implementations for the project-folders sidecar.

Authentication is handled entirely by the canonical scaffold: every route below
is reachable only with a valid WebUI-injected ``X-Hermes-Sidecar-Token``
(token-v1, deny-by-default at the scaffold's single dispatch chokepoint).
``/health`` is owned by the scaffold and carries no state.

Routes
------
GET  /v1/state                     project->workspace bindings + workspace discovery
POST /v1/bindings                  bind / unbind a project to a workspace
GET  /v1/hermes-md?workspace=...   read HERMES.md inside a validated workspace
PUT  /v1/hermes-md?workspace=...   write HERMES.md inside a validated workspace
GET  /v1/template                  HERMES.md starter template
POST /v1/generate-title            rename via the user-configured OpenAI-compatible endpoint

Workspace validation deliberately mirrors WebUI's resolve_trusted_workspace:
  (A) under the service user's home directory, OR
  (B) already in the WebUI saved workspaces list, OR
  (C) under the WebUI default workspace,
plus: never a system root, and the parent of a newly created directory must
already exist. HERMES.md is only ever read/written inside such a validated
workspace.

Title regeneration talks to ONE user-configured endpoint only
(PF_LLM_BASE_URL / PF_LLM_MODEL, default: a local OpenAI-compatible vLLM
server); the conversation transcript tail is never sent anywhere else.

Stdlib only. No third-party dependencies.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "1.2.0"
STARTED_AT = time.time()

# ── Configuration (env-overridable for tests) ────────────────────────────────
STATE_DIR = Path(
    os.environ.get("PF_STATE_DIR", str(Path(__file__).resolve().parent / "state"))
).expanduser()
WEBUI_STATE_DIR = Path(
    os.environ.get("PF_WEBUI_STATE_DIR")
    or os.environ.get("HERMES_WEBUI_STATE_DIR")
    or str(Path.home() / ".hermes" / "webui")
).expanduser()
MAX_HERMES_MD_BYTES = int(os.environ.get("PF_MAX_HERMES_MD_BYTES", str(200 * 1024)))
MAX_BODY_BYTES = int(os.environ.get("PF_MAX_BODY_BYTES", str(512 * 1024)))
MAX_WORKSPACE_LEN = 4096

# System roots that must never become a workspace (mirrors WebUI blocklist).
SYSTEM_ROOTS = {
    Path("/etc"), Path("/usr"), Path("/var"), Path("/bin"), Path("/sbin"),
    Path("/boot"), Path("/proc"), Path("/sys"), Path("/dev"), Path("/root"),
    Path("/"), Path("/lib"), Path("/lib64"), Path("/opt"), Path("/srv"),
    Path("/tmp"), Path("/run"), Path("/snap"),
}

_BINDINGS_FILE = STATE_DIR / "project-workspaces.json"
_LOCK = threading.RLock()


def _log(msg: str) -> None:
    try:
        print(f"[pf-sidecar] {msg}", file=sys.stderr, flush=True)
    except Exception:
        pass


# ── Request body helper ──────────────────────────────────────────────────────
def _json_body(req) -> dict | None:
    """Parse the raw request body as a JSON object, or None when invalid.
    The scaffold already caps the raw body at its own ceiling; this applies
    the extension's smaller JSON cap."""
    raw = req.body or b""
    if len(raw) > MAX_BODY_BYTES:
        return None
    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


# ── Bindings store ────────────────────────────────────────────────────────────
def _load_bindings() -> dict:
    try:
        if not _BINDINGS_FILE.exists():
            return {}
        raw = json.loads(_BINDINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            out = {}
            for pid, entry in raw.items():
                if not isinstance(pid, str) or not pid:
                    continue
                ws = None
                if isinstance(entry, dict):
                    ws = entry.get("workspace")
                elif isinstance(entry, str):
                    ws = entry
                if ws is not None and not isinstance(ws, str):
                    ws = None
                if not isinstance(ws, str) or not ws.strip():
                    ws = None
                out[pid] = {"workspace": ws}
            return out
    except Exception as exc:
        _log(f"bindings load failed: {exc}")
    return {}


def _save_bindings(bindings: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(STATE_DIR), prefix=".bindings-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(bindings, fh, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, _BINDINGS_FILE)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _webui_saved_workspaces() -> set[Path]:
    """Saved WebUI workspace list (rule B), best-effort."""
    paths: set[Path] = set()
    f = WEBUI_STATE_DIR / "workspaces.json"
    try:
        if f.exists():
            raw = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                items = raw.get("workspaces", raw)
            else:
                items = raw
            if isinstance(items, list):
                for w in items:
                    p = w.get("path") if isinstance(w, dict) else w
                    if isinstance(p, str) and p:
                        paths.add(Path(p).expanduser().resolve())
    except Exception:
        pass
    return paths


def _webui_default_workspace() -> Path | None:
    f = WEBUI_STATE_DIR / "settings.json"
    try:
        if f.exists():
            raw = json.loads(f.read_text(encoding="utf-8"))
            dw = raw.get("default_workspace") if isinstance(raw, dict) else None
            if isinstance(dw, str) and dw:
                return Path(dw).expanduser().resolve()
    except Exception:
        pass
    return None


def validate_workspace(raw, *, create: bool):
    """Validate a workspace path. Returns (path, None) or (None, error)."""
    if raw is None or not isinstance(raw, str):
        return None, "workspace must be a string"
    ws = raw.strip()
    if not ws:
        return None, "workspace is empty"
    if "\x00" in ws or "\n" in ws or "\r" in ws:
        return None, "workspace contains invalid characters"
    if len(ws) > MAX_WORKSPACE_LEN:
        return None, "workspace path too long"
    candidate = Path(ws).expanduser()
    if not candidate.is_absolute():
        return None, "workspace must be an absolute path"
    try:
        resolved = candidate.resolve(strict=False)
    except Exception as exc:
        return None, f"invalid workspace path: {exc}"

    if resolved in SYSTEM_ROOTS or str(resolved) in {str(s) for s in SYSTEM_ROOTS}:
        return None, "workspace points at a system directory"

    home = Path.home().resolve()
    try:
        if home != Path("/"):
            resolved.relative_to(home)
            allowed = True
        else:
            allowed = False
    except ValueError:
        allowed = False
    if not allowed:
        if resolved in _webui_saved_workspaces():
            allowed = True
        else:
            dw = _webui_default_workspace()
            if dw is not None:
                try:
                    resolved.relative_to(dw)
                    allowed = True
                except ValueError:
                    pass
    if not allowed:
        return None, (
            "workspace must be under the home directory, under the default "
            "workspace, or in the saved workspace list"
        )

    # Symlinks inside home are fine (WebUI allows them); resolve() already
    # followed them, so an escape from home was rejected by the check above.
    if create:
        if resolved.exists():
            if not resolved.is_dir():
                return None, "workspace exists and is not a directory"
        else:
            if not resolved.parent.is_dir():
                return None, "cannot create workspace: parent path does not exist"
            try:
                resolved.mkdir(parents=True)
                try:
                    os.chmod(resolved, 0o755)
                except OSError:
                    pass
            except OSError as exc:
                return None, f"cannot create workspace: {exc}"
    else:
        if not resolved.is_dir():
            return None, "workspace does not exist or is not a directory"
    return resolved, None


# ── HERMES.md access (only inside validated workspaces) ──────────────────────
def hermes_md_path(workspace: Path) -> Path:
    return workspace / "HERMES.md"


def read_hermes_md(workspace: Path) -> dict:
    p = hermes_md_path(workspace)
    if not p.is_file():
        return {"exists": False, "content": "", "path": str(p), "size": 0}
    try:
        data = p.read_bytes()
    except OSError as exc:
        return {"error": f"cannot read HERMES.md: {exc}"}
    return {
        "exists": True,
        "content": data.decode("utf-8", errors="replace"),
        "path": str(p),
        "size": len(data),
    }


HERMES_MD_TEMPLATE = """# Project

<!-- One or two sentences: what this project is. -->

## Current state

<!-- Where things stand right now. -->

## Important invariants

<!-- Rules that must not be broken. -->

## Relevant resources

<!-- Key files, paths, links the agent should know about. -->

## Working rules

<!-- How to work in this project. -->
"""


def write_hermes_md(workspace: Path, content) -> dict:
    if not isinstance(content, str):
        return {"error": "content must be a string"}
    data = content.encode("utf-8")
    if len(data) > MAX_HERMES_MD_BYTES:
        return {"error": f"content too large (max {MAX_HERMES_MD_BYTES} bytes)"}
    p = hermes_md_path(workspace)
    fd, tmp = tempfile.mkstemp(dir=str(workspace), prefix=".hermes-md-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.chmod(tmp, 0o644)
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return {"ok": True, "path": str(p), "size": len(data)}


# ── Title regeneration (OpenAI-compatible endpoint, user-configured) ─────────
# Configure via the sidecar's environment (systemd user drop-in):
#   PF_LLM_BASE_URL  — OpenAI-compatible endpoint (default: a local vLLM server)
#   PF_LLM_MODEL     — model id; when unset, the first id from /models is used
#   PF_LLM_TIMEOUT_S — request timeout seconds (keep below the WebUI proxy's
#                      ~10 s upstream timeout when the model is not local)
LLM_BASE_URL = os.environ.get("PF_LLM_BASE_URL", "http://127.0.0.1:8000/v1").rstrip("/")
LLM_MODEL = os.environ.get("PF_LLM_MODEL", "").strip()
LLM_TIMEOUT_S = float(os.environ.get("PF_LLM_TIMEOUT_S", "60"))
MAX_TITLE_CHARS = 80          # WebUI itself caps titles at 80
TRANSCRIPT_CHAR_BUDGET = 9000  # tail window of the conversation handed to the model

_TITLE_SYSTEM_PROMPT = (
    "You rename chat sessions. Read the conversation and output ONE short title "
    "(3-7 words, max 60 characters) that describes what the conversation is "
    "ACTUALLY about — the current topic, not just how it started. "
    "Reply in the same language as the conversation. "
    "Output only the title: no quotes, no period at the end, no prefix, no explanation."
)

_DEFAULT_MODEL_CACHE = ""


def _extract_transcript(messages: list) -> str:
    """Flatten session messages into a compact user/assistant transcript."""
    lines = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        if isinstance(content, list):  # multimodal parts
            content = " ".join(
                str(p.get("text", "")) for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            )
        content = re.sub(r"\s+", " ", str(content or "")).strip()
        if not content:
            continue
        if len(content) > 400:
            content = content[:400] + "…"
        lines.append(("USER: " if role == "user" else "ASSISTANT: ") + content)
    text = "\n".join(lines)
    return text[-TRANSCRIPT_CHAR_BUDGET:]  # keep the most recent tail


def _resolve_default_model() -> str:
    """First model id advertised by the endpoint (cached), used when
    PF_LLM_MODEL is unset."""
    global _DEFAULT_MODEL_CACHE
    if _DEFAULT_MODEL_CACHE:
        return _DEFAULT_MODEL_CACHE
    try:
        req = urllib.request.Request(LLM_BASE_URL + "/models", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        ids = [m.get("id") for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]
        _DEFAULT_MODEL_CACHE = str(ids[0]) if ids else ""
    except Exception:
        _DEFAULT_MODEL_CACHE = ""
    return _DEFAULT_MODEL_CACHE


def _clean_model_title(raw: str) -> str:
    t = (raw or "").strip()
    t = t.splitlines()[0] if t else ""
    t = t.strip().strip('"').strip("'").strip("«»“”").strip()
    t = re.sub(r"^(?:title|название|заголовок)\s*[:\-–]\s*", "", t, flags=re.IGNORECASE)
    t = t.rstrip(".。!").strip()
    return t[:MAX_TITLE_CHARS]


def generate_title(messages: list) -> dict:
    transcript = _extract_transcript(messages)
    if not transcript:
        return {"error": "no user/assistant messages to summarize"}
    model = LLM_MODEL or _resolve_default_model()
    if not model:
        return {"error": f"no model configured (PF_LLM_MODEL unset and {LLM_BASE_URL}/models unreachable)"}
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": _TITLE_SYSTEM_PROMPT},
            {"role": "user", "content": "Conversation:\n" + transcript + "\n\nTitle:"},
        ],
        "max_tokens": 400,   # the model "thinks" before the visible answer (separate field)
        "temperature": 0.3,
    }).encode("utf-8")
    req = urllib.request.Request(
        LLM_BASE_URL + "/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"error": f"LLM HTTP {exc.code}"}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"error": f"LLM unreachable: {exc}"}
    except Exception as exc:
        return {"error": f"LLM response parse failed: {exc}"}
    try:
        raw = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return {"error": "unexpected LLM response shape"}
    title = _clean_model_title(raw)
    if not title:
        return {"error": "model returned an empty title"}
    return {"title": title}


# ── Routes (auth is inherited from the scaffold; nothing here touches the token) ─
def register(app):
    @app.route("GET", "/v1/state")
    def get_state(req):
        with _LOCK:
            bindings = _load_bindings()
        return app.json({
            "bindings": bindings,
            "default_workspace": str(_webui_default_workspace() or ""),
            "saved_workspaces": sorted(str(p) for p in _webui_saved_workspaces()),
        })

    @app.route("GET", "/v1/hermes-md")
    def get_hermes_md(req):
        ws, err = validate_workspace(req.query_one("workspace", ""), create=False)
        if err:
            return app.json({"error": err}, status=400)
        return app.json(read_hermes_md(ws))

    @app.route("PUT", "/v1/hermes-md")
    def put_hermes_md(req):
        ws, err = validate_workspace(req.query_one("workspace", ""), create=False)
        if err:
            return app.json({"error": err}, status=400)
        body = _json_body(req)
        if body is None or "content" not in body:
            return app.json({"error": 'body must be {"content": ...}'}, status=400)
        try:
            with _LOCK:
                result = write_hermes_md(ws, body["content"])
        except OSError as exc:
            return app.json({"error": str(exc)}, status=500)
        if "error" in result:
            return app.json(result, status=400)
        return app.json(result)

    @app.route("GET", "/v1/template")
    def get_template(req):
        return app.json({"template": HERMES_MD_TEMPLATE})

    @app.route("POST", "/v1/bindings")
    def post_bindings(req):
        body = _json_body(req)
        if body is None:
            return app.json({"error": "invalid JSON body"}, status=400)
        pid = body.get("project_id")
        if not isinstance(pid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", pid):
            return app.json({"error": "invalid project_id"}, status=400)
        ws_raw = body.get("workspace", None)
        with _LOCK:
            bindings = _load_bindings()
            if ws_raw in (None, "", False):
                bindings.pop(pid, None)
                _save_bindings(bindings)
                return app.json({"ok": True, "project_id": pid, "workspace": None})
            ws, err = validate_workspace(ws_raw, create=True)
            if err:
                return app.json({"error": err}, status=400)
            bindings[pid] = {"workspace": str(ws)}
            _save_bindings(bindings)
        return app.json({"ok": True, "project_id": pid, "workspace": str(ws)})

    @app.route("POST", "/v1/generate-title")
    def post_generate_title(req):
        body = _json_body(req)
        if body is None:
            return app.json({"error": "invalid JSON body (too large or malformed)"}, status=400)
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return app.json({"error": "body must contain a non-empty 'messages' list"}, status=400)
        if len(messages) > 5000:
            return app.json({"error": "too many messages"}, status=400)
        result = generate_title(messages)
        return app.json(result, status=200 if "title" in result else 502)
