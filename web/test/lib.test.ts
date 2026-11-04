import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFilter, quoteValue, replaceField, tokenAt } from '../src/lib/filters.ts';
import { rowFields, waterfall, type Span } from '../src/lib/rows.ts';
import { DEFAULT_STATE, dorisTimeToMs, parseState, resolveWindow, serializeState } from '../src/lib/state.ts';

test('state round-trips through the URL', () => {
  const s = { source: 'traces' as const, q: 'service:"a b" -x', window: { from: 1000, to: 5000 }, trace: 'ab'.repeat(16) };
  assert.deepEqual(parseState(serializeState(s)), s);
  const p = { ...DEFAULT_STATE, window: { preset: '24h' as const } };
  assert.deepEqual(parseState(serializeState(p)), p);
});

test('bad URL values fall back to defaults', () => {
  assert.deepEqual(parseState('?source=x&t=99y&trace=nothex'), DEFAULT_STATE);
  assert.deepEqual(parseState('?from=5&to=1').window, DEFAULT_STATE.window);
});

test('presets end now', () => {
  assert.deepEqual(resolveWindow({ preset: '15m' }, 1_000_000_000), { from: 1_000_000_000 - 900_000, to: 1_000_000_000 });
  assert.equal(dorisTimeToMs('2026-11-04 05:00:00.250000'), Date.UTC(2026, 10, 4, 5, 0, 0, 250));
});

test('filters are quoted, deduplicated and flip between include and exclude', () => {
  assert.equal(quoteValue('say "hi" \\o/'), '"say \\"hi\\" \\\\o/"');
  assert.equal(addFilter('', 'service_name', 'cart'), 'service_name:"cart"');
  assert.equal(addFilter('timeout', 'level', 'ERROR'), 'timeout level:"ERROR"');
  assert.equal(addFilter('timeout level:"ERROR"', 'level', 'ERROR'), 'timeout level:"ERROR"');
  assert.equal(addFilter('timeout level:"ERROR"', 'level', 'ERROR', true), 'timeout -level:"ERROR"');
  assert.equal(addFilter('-k8s.pod.name:"a b"', 'k8s.pod.name', 'a b'), 'k8s.pod.name:"a b"');
});

test('tokenAt finds the field being typed', () => {
  assert.deepEqual(tokenAt('level:ER', 8), { start: 0, end: 8, field: 'level', value: 'ER' });
  assert.deepEqual(tokenAt('a -k8s.po', 9), { start: 3, end: 9, field: null, value: 'k8s.po' });
  assert.deepEqual(tokenAt('(service:"ca', 12), { start: 1, end: 12, field: 'service', value: 'ca' });
});

test('row fields flatten attribute JSON to dotted paths', () => {
  const f = rowFields({
    body: 'hi', trace_id: '', severity_number: 9,
    resource_attributes: '{"k8s":{"pod":{"name":"cart-1"}},"host.name":"h"}',
    log_attributes: { thread: { id: 7 } }, events: '[]',
  });
  assert.deepEqual(f, [
    { field: 'body', value: 'hi', group: 'fields' },
    { field: 'severity_number', value: '9', group: 'fields' },
    { field: 'k8s.pod.name', value: 'cart-1', group: 'resource_attributes' },
    { field: 'host.name', value: 'h', group: 'resource_attributes' },
    { field: 'thread.id', value: '7', group: 'log_attributes' },
  ]);
});

test('waterfall orders spans as a tree and measures offsets', () => {
  const s = (id: string, parent: string, t: string, us: number): Span => ({
    span_id: id, parent_span_id: parent, service_name: 's', span_name: id, timestamp: t, duration: us, status_code: '',
  });
  const spans = [
    s('c2', 'root', '2026-11-04 00:00:00.300000', 100_000),
    s('root', '', '2026-11-04 00:00:00.000000', 1_000_000),
    s('c1', 'root', '2026-11-04 00:00:00.100000', 50_000),
    s('g1', 'c1', '2026-11-04 00:00:00.120000', 10_000),
    s('orphan', 'missing', '2026-11-04 00:00:00.500000', 600_000),
  ];
  const { rows, totalMs } = waterfall(spans, dorisTimeToMs);
  assert.deepEqual(rows.map((r) => [r.span.span_id, r.depth]), [['root', 0], ['c1', 1], ['g1', 2], ['c2', 1], ['orphan', 0]]);
  assert.equal(rows[2]!.offsetMs, 120);
  assert.equal(rows[2]!.durationMs, 10);
  assert.equal(totalMs, 1100);
});

test('replaceField fixes a misspelled field everywhere, and only as a field', () => {
  assert.equal(replaceField('levl:ERROR (levl:WARN OR -levl:INFO) levl', 'levl', 'level'),
    'level:ERROR (level:WARN OR -level:INFO) levl');
  assert.equal(replaceField('k8s.pod.nme:a xk8s.pod.nme:b', 'k8s.pod.nme', 'k8s.pod.name'), 'k8s.pod.name:a xk8s.pod.nme:b');
});
