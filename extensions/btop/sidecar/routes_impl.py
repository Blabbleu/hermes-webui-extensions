"""btop sidecar routes. Auth (token-v1) is enforced by the vendored scaffold;
nothing here touches the token.

  GET  /api/snapshot?since=<seq>&boot=<id>&procs=0|1   live state + history delta
  GET  /api/proc/{pid}                                 one process in detail
  POST /api/proc/{pid}/signal   {"signal": "TERM"}     TERM KILL INT HUP STOP CONT
"""
from __future__ import annotations

import json
import os
import threading

from collector import Collector

COLLECTOR = Collector(interval=float(os.getenv("BTOP_INTERVAL", "1.0")))


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def register(app) -> None:
    @app.route("GET", "/api/snapshot")
    def snapshot(req):
        payload = COLLECTOR.snapshot(
            since=_int(req.query_one("since"), 0),
            boot=req.query_one("boot", "") or "",
            want_procs=req.query_one("procs", "1") != "0",
        )
        status, headers, body = app.json(payload)
        headers["Cache-Control"] = "no-store"
        return status, headers, body

    @app.route("GET", "/api/proc/{pid}")
    def proc(req):
        pid = _int(req.params.get("pid"), -1)
        if pid <= 0:
            return app.json({"error": "bad pid"}, status=400)
        detail = COLLECTOR.proc_detail(pid)
        if detail is None:
            return app.json({"error": "no such process"}, status=404)
        return app.json(detail)

    @app.route("POST", "/api/proc/{pid}/signal")
    def proc_signal(req):
        pid = _int(req.params.get("pid"), -1)
        if pid <= 0:
            return app.json({"error": "bad pid"}, status=400)
        try:
            body = json.loads(req.body or b"{}")
        except ValueError:
            return app.json({"error": "bad json"}, status=400)
        status, payload = COLLECTOR.send_signal(pid, (body or {}).get("signal", ""))
        return app.json(payload, status=status)


def start_background(app) -> None:
    COLLECTOR.sample()
    threading.Thread(target=COLLECTOR.run_forever, name="btop-sampler", daemon=True).start()
