// btop core helpers: formatting, history merge, sort, filter grammar, tree.
// Runs in this repo (extension/) and in the gallery (extensions/btop/):  node --test <this file>
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CORE = ['../extension/assets/btop-core.js', '../extensions/btop/assets/btop-core.js']
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((p) => existsSync(p));
// Same-realm load (deepStrictEqual compares prototypes), independent of the
// surrounding package.json "type", via the UMD module.exports branch.
const mod = { exports: {} };
new vm.Script('(function (module) {' + readFileSync(CORE, 'utf8') + '\n})', { filename: CORE })
  .runInThisContext()(mod);
const C = mod.exports;

const procs = [
  { pid: 1, ppid: 0, name: 'systemd', cmd: '/sbin/init', user: 'root', cpu: 0, mem: 8e6, threads: 1, group: null },
  { pid: 100, ppid: 1, name: 'python3', cmd: '/opt/hermes-webui/server.py', user: 'root', cpu: 3.5, mem: 4.8e8, threads: 20, group: 'webui' },
  { pid: 101, ppid: 100, name: 'node', cmd: 'node pyright-langserver --stdio', user: 'root', cpu: 0.5, mem: 2.6e8, threads: 9, group: 'webui' },
  { pid: 200, ppid: 1, name: 'hermes', cmd: 'python3 -I -c hermes', user: 'root', cpu: 12, mem: 3.7e8, threads: 30, group: 'agent' },
  { pid: 201, ppid: 200, name: 'bash', cmd: 'bash -c ls', user: 'root', cpu: 0, mem: 3e6, threads: 1, group: 'agent' },
  { pid: 300, ppid: 1, name: 'sshd', cmd: 'sshd: /usr/sbin/sshd -D', user: 'root', cpu: 0, mem: 5e5, threads: 1, group: null },
  { pid: 400, ppid: 1, name: 'node', cmd: 'node server.js', user: 'blabbleu', cpu: 1, mem: 3.4e7, threads: 11, group: null },
];

test('fmtBytes', () => {
  assert.equal(C.fmtBytes(0), '0 B');
  assert.equal(C.fmtBytes(1536), '1.50 KiB');
  assert.equal(C.fmtBytes(4294967296), '4.00 GiB');
  assert.equal(C.fmtBytes(2048, { rate: true }), '2.00 KiB/s');
  assert.equal(C.fmtBytes(512 * 1024 * 1024, { compact: true }), '512M');
  assert.equal(C.fmtBytes(null), '–');
});

test('fmtBits / durations', () => {
  assert.equal(C.fmtBits(125000), '1.0 Mbps');
  assert.equal(C.fmtDuration(59), '59s');
  assert.equal(C.fmtDuration(3725), '1h 02m');
  assert.equal(C.fmtDuration(90061), '1d 1h');
  assert.equal(C.fmtUptime(1381904), '15d 23:51');
});

test('mergeHistory appends only newer samples and caps length', () => {
  const h = [{ s: 1 }, { s: 2 }];
  const out = C.mergeHistory(h, [{ s: 2 }, { s: 3 }, { s: 4 }], 3);
  assert.deepEqual(out.map((x) => x.s), [2, 3, 4]);
  assert.deepEqual(C.mergeHistory(h, [], 10).map((x) => x.s), [1, 2]);
});

test('fitSeries pads the front so short history is flush right', () => {
  assert.deepEqual(C.fitSeries([1, 2], 4), [null, null, 1, 2]);
  assert.deepEqual(C.fitSeries([1, 2, 3, 4, 5], 3), [3, 4, 5]);
});

test('sparkline scales to max', () => {
  assert.equal(C.sparkline([0, 50, 100], 100, 3), ' ▄█');
  assert.equal(C.sparkline([], 100, 2), '  ');
});

test('sort by cpu desc and by name asc', () => {
  assert.deepEqual(C.sortProcs(procs, 'cpu', true).slice(0, 3).map((p) => p.pid), [200, 100, 400]);
  assert.equal(C.sortProcs(procs, 'name', false)[0].name, 'bash');
});

test('filter terms: text, pid, user, group, negation, hermes', () => {
  assert.deepEqual(C.filterProcs(procs, 'node').map((p) => p.pid), [101, 400]);
  assert.deepEqual(C.filterProcs(procs, '200').map((p) => p.pid), [200]);
  assert.deepEqual(C.filterProcs(procs, 'blabbleu').map((p) => p.pid), [400]);
  assert.deepEqual(C.filterProcs(procs, 'g:webui').map((p) => p.pid), [100, 101]);
  assert.deepEqual(C.filterProcs(procs, 'node !g:webui').map((p) => p.pid), [400]);
  assert.deepEqual(C.filterProcs(procs, 'g:*').map((p) => p.pid).sort(), [100, 101, 200, 201]);
  assert.deepEqual(C.filterProcs(procs, 'hermes').map((p) => p.pid).sort(), [100, 101, 200, 201]);
  assert.equal(C.filterProcs(procs, '').length, procs.length);
});

test('tree: structure, prefixes, collapse, filtered ancestors dimmed', () => {
  const rows = C.buildTree(procs, 'cpu', true, '', new Set());
  assert.equal(rows[0].pid, 1);
  assert.equal(rows[0].depth, 0);
  const kids = rows.filter((r) => r.depth === 1).map((r) => r.pid);
  assert.deepEqual(kids, [200, 100, 400, 300]);
  const last = rows.find((r) => r.pid === 300);
  assert.equal(last.prefix, '└─');
  const nested = rows.find((r) => r.pid === 201);
  assert.equal(nested.depth, 2);
  assert.equal(nested.prefix, '│ └─');

  const collapsed = C.buildTree(procs, 'cpu', true, '', new Set([200]));
  assert.ok(!collapsed.some((r) => r.pid === 201));
  assert.ok(collapsed.find((r) => r.pid === 200).collapsed);

  const filtered = C.buildTree(procs, 'cpu', true, 'pyright', new Set());
  assert.deepEqual(filtered.map((r) => r.pid), [1, 100, 101]);
  assert.ok(filtered[0].dimmed && filtered[1].dimmed && !filtered[2].dimmed);
});

test('tree tolerates cycles and missing parents', () => {
  const weird = [{ pid: 5, ppid: 6, name: 'a', cpu: 0, mem: 0 }, { pid: 6, ppid: 5, name: 'b', cpu: 0, mem: 0 }, { pid: 7, ppid: 999, name: 'c', cpu: 0, mem: 0 }];
  const rows = C.buildTree(weird, 'pid', false, '', new Set());
  assert.ok(rows.some((r) => r.pid === 7));
  assert.ok(rows.length <= 3);
});

test('pickIface prefers busiest non-loopback', () => {
  const net = { lo: { rx_total: 9e12, tx_total: 9e12 }, eth0: { rx_total: 1e9, tx_total: 1e9 }, docker0: { rx_total: 1e6, tx_total: 1e6 } };
  assert.equal(C.pickIface(net), 'eth0');
  assert.equal(C.pickIface({ lo: { rx_total: 1, tx_total: 1 } }), 'lo');
});
