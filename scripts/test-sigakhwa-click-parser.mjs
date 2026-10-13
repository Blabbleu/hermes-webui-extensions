'use strict';
// node --test — pure-function tests for the §4 sigakhwa-actions parser, the Mermaid id helper and
// the §5 selection templates. The extension script runs via vm.runInThisContext with a bare fake window and
// a minimal Korean locale document, so its DOM install path is skipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../extensions/sigakhwa-click/assets/sigakhwa-click.js', import.meta.url), 'utf8');

function load() {
  global.document = { documentElement: { lang: 'ko' }, readyState: 'loading', addEventListener: function () {} };
  global.window = {};
  vm.runInThisContext(SOURCE, { filename: 'sigakhwa-click.js' });
  return global.window.SigakhwaClick;
}

const VALID = JSON.stringify({ v: 1, nodes: { B: { prompt: '이 연결 과정을 더 자세한 그림으로 보여줘', label: '더 자세히' } } });
const IDS = ['A', 'B', 'C', 'D'];

test('load: frozen global, idempotent, no install without a document', () => {
  const api = load();
  assert.equal(api.version, 1);
  assert.ok(Object.isFrozen(api));
  const first = api;
  vm.runInThisContext(SOURCE, { filename: 'sigakhwa-click.js' });
  assert.equal(global.window.SigakhwaClick, first);
  assert.equal(api.install(), false, 'install refuses when document/MutationObserver are missing');
});

test('parseActions: valid block → one bound node with label', () => {
  const api = load();
  const res = api.parseActions(VALID, IDS);
  assert.equal(res.ok, true);
  assert.equal(res.diagram, null);
  assert.deepEqual(res.nodes, [{ id: 'B', prompt: '이 연결 과정을 더 자세한 그림으로 보여줘', label: '더 자세히' }]);
  assert.equal(res.dropped, 0);
  // explicit diagram index
  const res2 = api.parseActions(JSON.stringify({ v: 1, diagram: 1, nodes: { A: { prompt: 'x' } } }), IDS);
  assert.equal(res2.ok, true);
  assert.equal(res2.diagram, 1);
  // without a known-id list the membership check is skipped (the DOM binder validates later)
  assert.equal(api.parseActions(JSON.stringify({ v: 1, nodes: { Zed: { prompt: 'x' } } })).ok, true);
});

test('parseActions: structural failures ignore the whole block', () => {
  const api = load();
  const bad = {
    not_string: 42,
    empty: '   ',
    not_json: '{"v":1, nodes: oops',
    not_object: '[1,2,3]',
    version: JSON.stringify({ v: 2, nodes: { A: { prompt: 'x' } } }),
    version_missing: JSON.stringify({ nodes: { A: { prompt: 'x' } } }),
    nodes_missing: JSON.stringify({ v: 1 }),
    nodes_array: JSON.stringify({ v: 1, nodes: [{ prompt: 'x' }] }),
    no_nodes: JSON.stringify({ v: 1, nodes: {} }),
    diagram_negative: JSON.stringify({ v: 1, diagram: -1, nodes: { A: { prompt: 'x' } } }),
    diagram_string: JSON.stringify({ v: 1, diagram: '0', nodes: { A: { prompt: 'x' } } }),
    diagram_float: JSON.stringify({ v: 1, diagram: 0.5, nodes: { A: { prompt: 'x' } } }),
    too_large: JSON.stringify({ v: 1, nodes: { A: { prompt: 'x', pad: 'y'.repeat(20000) } } }),
  };
  for (const [label, raw] of Object.entries(bad)) {
    const res = api.parseActions(raw, IDS);
    assert.equal(res.ok, false, label);
  }
  // >12 nodes → whole block ignored
  const many = { v: 1, nodes: {} };
  for (let i = 0; i < 13; i++) many.nodes['N' + i] = { prompt: 'p' + i };
  assert.equal(api.parseActions(JSON.stringify(many)).ok, false);
  const twelve = { v: 1, nodes: {} };
  for (let i = 0; i < 12; i++) twelve.nodes['N' + i] = { prompt: 'p' + i };
  assert.equal(api.parseActions(JSON.stringify(twelve)).ok, true);
});

test('parseActions: bad ids / unknown ids / bad prompts are dropped, others survive', () => {
  const api = load();
  const raw = JSON.stringify({
    v: 1,
    nodes: {
      'B': { prompt: 'ok' },
      '1bad': { prompt: 'starts with a digit' },
      'has space': { prompt: 'x' },
      ['A'.repeat(40)]: { prompt: 'too long id' },
      'Z': { prompt: 'not in the diagram' },
      'C': { prompt: 'x'.repeat(501) },
      'D': { prompt: '' },
      'A': { prompt: '   ' },
    },
  });
  const res = api.parseActions(raw, IDS);
  assert.equal(res.ok, true);
  assert.deepEqual(res.nodes.map((n) => n.id), ['B']);
  assert.equal(res.dropped, 7);
  // exactly 500 chars is fine
  assert.equal(api.parseActions(JSON.stringify({ v: 1, nodes: { A: { prompt: 'x'.repeat(500) } } }), IDS).nodes.length, 1);
  // everything dropped → block ignored
  assert.equal(api.parseActions(JSON.stringify({ v: 1, nodes: { Z: { prompt: 'x' } } }), IDS).ok, false);
});

test('parseActions: nested junk, URL/JS payloads and slash commands are never acted upon', () => {
  const api = load();
  const raw = JSON.stringify({
    v: 1,
    nodes: {
      A: { url: 'https://evil.example/x', href: 'javascript:alert(1)', onclick: 'alert(1)' },     // no prompt → dropped
      B: { prompt: 'fine', url: 'https://evil.example/x', js: 'alert(1)', nested: { deep: [1, { a: 2 }] } }, // junk ignored
      C: { prompt: ['not', 'a', 'string'] },
      D: { prompt: { text: 'object' } },
    },
    extra: { shell: 'rm -rf /' },
  });
  const res = api.parseActions(raw, IDS);
  assert.equal(res.ok, true);
  assert.deepEqual(res.nodes, [{ id: 'B', prompt: 'fine', label: null }]);
  assert.equal(Object.keys(res.nodes[0]).sort().join(','), 'id,label,prompt', 'only prompt/label are carried');
  // leading slash would reach core's slash-command surface → dropped
  assert.equal(api.parseActions(JSON.stringify({ v: 1, nodes: { A: { prompt: '/terminal rm -rf /' } } }), IDS).ok, false);
  // control characters in a prompt → dropped; \n is allowed
  assert.equal(api.parseActions(JSON.stringify({ v: 1, nodes: { A: { prompt: 'a\u0007b' } } }), IDS).ok, false);
  assert.equal(api.parseActions(JSON.stringify({ v: 1, nodes: { A: { prompt: 'line1\nline2' } } }), IDS).ok, true);
  // invalid label is ignored, the node stays
  const lbl = api.parseActions(JSON.stringify({ v: 1, nodes: { A: { prompt: 'x', label: 'L'.repeat(21) } } }), IDS);
  assert.equal(lbl.nodes[0].label, null);
  const lbl2 = api.parseActions(JSON.stringify({ v: 1, nodes: { A: { prompt: 'x', label: 42 } } }), IDS);
  assert.equal(lbl2.nodes[0].label, null);
});

test('nodeIdFromDomId: flowchart-<Id>-<n> prefix match, suffix ignored', () => {
  const api = load();
  assert.equal(api.nodeIdFromDomId('flowchart-B-9'), 'B');
  assert.equal(api.nodeIdFromDomId('flowchart-A-8'), 'A');
  assert.equal(api.nodeIdFromDomId('flowchart-step_2-120'), 'step_2');
  assert.equal(api.nodeIdFromDomId('flowchart-my-node-3'), 'my-node');
  assert.equal(api.nodeIdFromDomId('mermaid-lightbox-abc-flowchart-B-9'), null, 'lightbox clones are found via data attributes, not ids');
  assert.equal(api.nodeIdFromDomId('flowchart-'), null);
  assert.equal(api.nodeIdFromDomId('edge-1'), null);
  assert.equal(api.nodeIdFromDomId(null), null);
});

test('renderTemplate: the four §5 templates quote the trimmed selection as a blockquote', () => {
  const api = load();
  assert.deepEqual(api.templates.map((t) => t.label), ['쉽게 설명', '근거 확인', '시각화', '대안 비교']);
  const sel = '  Tailscale은 WireGuard 위에서\n키를 교환한다.  ';
  assert.equal(api.renderTemplate('explain', sel), '다음 부분을 더 쉽게 설명해줘:\n\n> Tailscale은 WireGuard 위에서\n> 키를 교환한다.');
  assert.equal(api.renderTemplate('evidence', 'x'), '다음 내용의 근거를 확인해줘. 출처나 근거를 댈 수 없으면 그렇게 말해줘:\n\n> x');
  assert.equal(api.renderTemplate('visualize', 'x'), '시각화\n\n> x');
  assert.ok(!api.renderTemplate('visualize', 'x').startsWith('/'), 'slash-less trigger');
  assert.equal(api.renderTemplate('compare', 'x'), '다음 내용에 대한 대안 2~3개를 비교해줘:\n\n> x');
  assert.equal(api.renderTemplate('nope', 'x'), null);
  assert.equal(api.renderTemplate('explain', '   '), null);
});

test('renderTemplate: selection clipped to ≤1000 chars and the message stays ≤2000 chars', () => {
  const api = load();
  const long = 'ㄱ'.repeat(1500);
  const out = api.renderTemplate('explain', long);
  const quoted = out.split('\n\n')[1];
  assert.ok(quoted.startsWith('> '));
  assert.equal(quoted.length - 2, 1000, 'selection body is exactly 1000 chars incl. the ellipsis');
  assert.ok(quoted.endsWith('…'));
  assert.ok(out.length <= 2000);
  // many short lines: blockquote prefixes must not push the message over the send cap
  const lines = Array.from({ length: 600 }, (_, i) => 'l' + i).join('\n');
  const out2 = api.renderTemplate('compare', lines);
  assert.ok(out2 && out2.length <= 2000, 'kept within HermesVizSend cap');
  assert.ok(out2.split('\n').slice(2).every((l) => l.startsWith('> ')));
});

test('normalizeSelection collapses nbsp / CRLF / blank runs', () => {
  const api = load();
  assert.equal(api.normalizeSelection('a b\r\nc  \n\n\n\nd'), 'a b\nc\n\nd');
});
