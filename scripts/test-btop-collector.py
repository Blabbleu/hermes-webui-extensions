"""Collector tests: pure parsers on fixtures, plus one live /proc smoke run.

    python3 tests/test-btop-collector.py
"""
import json
import os
import sys
import time
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # keep the vendored sidecar dir clean when run from the gallery
_ROOT = Path(__file__).resolve().parent.parent
for _cand in (_ROOT / "extension" / "sidecar", _ROOT / "extensions" / "btop" / "sidecar"):
    if (_cand / "collector.py").is_file():
        sys.path.insert(0, str(_cand))
        break
import collector as c  # noqa: E402

STAT = """cpu  100 0 50 800 50 0 0 0 0 0
cpu0 50 0 25 400 25 0 0 0 0 0
cpu1 50 0 25 400 25 0 0 0 0 0
ctxt 12345
procs_running 3
procs_blocked 1
"""
STAT2 = """cpu  160 0 70 860 60 0 0 10 0 0
cpu0 100 0 35 420 30 0 0 5 0 0
cpu1 60 0 35 440 30 0 0 5 0 0
"""


class Parsers(unittest.TestCase):
    def test_stat_and_cpu_percent(self):
        a, b = c.parse_stat(STAT), c.parse_stat(STAT2)
        self.assertEqual(len(a["cores"]), 2)
        self.assertEqual(a["procs_running"], 3)
        p = c.cpu_percent(a["total"], b["total"])
        # dt = 1160-1000 = 160 ; idle delta = (860+60)-(800+50) = 70 -> busy 90
        self.assertAlmostEqual(p["total"], 56.2, places=1)
        self.assertAlmostEqual(p["user"], 37.5, places=1)
        self.assertAlmostEqual(p["steal"], 6.2, places=1)
        self.assertEqual(c.cpu_percent(a["total"], a["total"])["total"], 0.0)

    def test_meminfo(self):
        mi = c.parse_meminfo("MemTotal: 4000 kB\nMemFree: 500 kB\nMemAvailable: 1500 kB\nBuffers: 0 kB\n"
                             "Cached: 1200 kB\nSReclaimable: 100 kB\nShmem: 50 kB\nSwapTotal: 1000 kB\nSwapFree: 400 kB\n")
        m = c.mem_summary(mi)
        self.assertEqual(m["total"], 4000 * 1024)
        self.assertEqual(m["used"], 2500 * 1024)
        self.assertEqual(m["cached"], 1250 * 1024)
        self.assertEqual(m["swap_used"], 600 * 1024)

    def test_net_disk_load(self):
        net = c.parse_net_dev("h1\nh2\n  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n    lo: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n")
        self.assertEqual(net["eth0"], (100, 200))
        d = c.parse_diskstats("   7       0 loop0 10 0 2 0 20 0 4 0 0 30 0 0 0 0 0 0 0\n")
        self.assertEqual(d["loop0"], (2 * 512, 4 * 512, 30))
        l = c.parse_loadavg("3.65 3.26 2.17 2/1296 99\n")
        self.assertEqual(l["load"], [3.65, 3.26, 2.17])
        self.assertEqual((l["running"], l["threads"]), (2, 1296))

    def test_proc_stat_with_spaces_and_parens(self):
        line = "42 (my (weird) proc) S 1 42 42 0 -1 4194560 100 0 0 0 7 3 0 0 20 0 4 0 5000 1000000 250 18446744073709551615"
        p = c.parse_proc_stat(line)
        self.assertEqual(p["comm"], "my (weird) proc")
        self.assertEqual(p["ppid"], 1)
        self.assertEqual(p["utime"] + p["stime"], 10)
        self.assertEqual(p["threads"], 4)
        self.assertEqual(p["rss"], 250 * c.PAGE_SIZE)
        self.assertIsNone(c.parse_proc_stat("garbage"))

    def test_cpuinfo(self):
        info = c.parse_cpuinfo("model name\t: Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz\ncpu MHz\t\t: 3000.0\n"
                               "model name\t: x\ncpu MHz\t\t: 4000.0\n")
        self.assertEqual(info, {"model": "Intel Core i5-7500 @ 3.40GHz", "mhz": 3500})

    def test_mask_secrets(self):
        s = c.mask_secrets('curl -H "Authorization: Bearer abcdef123456" https://user:hunter2@x.com '
                           '--api-key sk-ant-abc123456789 TOKEN=xyz --password=p4ss ghp_abcdefghijklmn plain --verbose')
        for leak in ("abcdef123456", "hunter2", "sk-ant-abc123456789", "xyz", "p4ss", "ghp_abcdefghijklmn"):
            self.assertNotIn(leak, s)
        self.assertIn("plain --verbose", s)
        self.assertEqual(c.mask_secrets("python3 server.py --port 8787"), "python3 server.py --port 8787")

    def test_hermes_groups_and_inheritance(self):
        self.assertEqual(c.hermes_group("python3", "/x/python3 /opt/hermes-webui/server.py"), "webui")
        self.assertEqual(c.hermes_group("hermes", "/x/python3 -I -c import os"), "agent")
        self.assertEqual(c.hermes_group("node", "node /root/.npm/_npx/x/node_modules/.bin/rea mcp"), "mcp")
        self.assertEqual(c.hermes_group("python", "/venv/bin/python /opt/swe-pilot/swe_pilot/broker.py"), "swe-pilot")
        self.assertEqual(c.hermes_group("python3", "python3 -m cron.scheduler --external-worker-file f"), "cron")
        self.assertIsNone(c.hermes_group("sshd", "sshd: /usr/sbin/sshd -D"))
        self.assertIsNone(c.hermes_group("bash", "/bin/bash"))
        procs = {
            1: {"ppid": 0, "own_group": None},
            10: {"ppid": 1, "own_group": "webui"},
            11: {"ppid": 10, "own_group": None},
            12: {"ppid": 11, "own_group": None},
            13: {"ppid": 10, "own_group": "mcp"},
            20: {"ppid": 1, "own_group": None},
        }
        c.assign_groups(procs)
        self.assertEqual([procs[p]["group"] for p in (1, 10, 11, 12, 13, 20)],
                         [None, "webui", "webui", "webui", "mcp", None])


@unittest.skipUnless(Path("/proc/stat").exists(), "needs Linux /proc")
class Live(unittest.TestCase):
    def test_snapshot_shape_and_size(self):
        col = c.Collector()
        col.sample()
        col.snapshot()
        time.sleep(0.6)
        col.sample()
        snap = col.snapshot(since=0)
        now = snap["now"]
        self.assertGreater(now["ncpu"], 0)
        self.assertEqual(len(now["cores"]), now["ncpu"])
        self.assertGreater(now["mem"]["total"], 0)
        self.assertGreater(len(snap["procs"]), 0)
        self.assertLessEqual(len(snap["procs"]), c.MAX_PROCS)
        self.assertGreaterEqual(snap["proc_total"], len(snap["procs"]))
        self.assertEqual(len(snap["history"]), 2)
        self.assertLess(len(json.dumps(snap)), 512 * 1024)
        delta = col.snapshot(since=snap["seq"], boot=snap["boot"])
        self.assertEqual(delta["history"], [])
        reset = col.snapshot(since=snap["seq"], boot="other")
        self.assertEqual(len(reset["history"]), 2)

    def test_detail_and_signal_guards(self):
        col = c.Collector()
        col.sample()
        d = col.proc_detail(os.getpid())
        self.assertEqual(d["pid"], os.getpid())
        self.assertIsNotNone(d["cwd"])
        self.assertIsNone(col.proc_detail(2 ** 22 + 12345))
        self.assertEqual(col.send_signal(1, "KILL")[0], 400)
        self.assertEqual(col.send_signal(os.getpid(), "TERM")[0], 400)
        self.assertEqual(col.send_signal(12345, "SEGV")[0], 400)
        self.assertEqual(col.send_signal(2 ** 22 + 12345, "TERM")[0], 404)
        col.signals_enabled = False
        self.assertEqual(col.send_signal(12345, "TERM")[0], 403)


if __name__ == "__main__":
    unittest.main()
