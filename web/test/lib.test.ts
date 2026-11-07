import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFilter, quoteValue, replaceField, tokenAt } from '../src/lib/filters.ts';
import { rowFields, waterfall, type Span } from '../src/lib/rows.ts';
import { minePatterns, template } from '../src/lib/patterns.ts';
import { DEFAULT_STATE, dorisTimeToMs, parseState, presetLabel, resolveWindow, serializeState, toggleFilter } from '../src/lib/state.ts';

test('state round-trips through the URL', () => {
  const s = {
    source: 'traces' as const, where: "service:\"a b\" -x", language: 'sql' as const,
    filters: [{ field: 'k8s.pod.name', values: ['a', 'b'] }, { field: 'service', values: ['c'], exclude: true }],
    select: 'timestamp, span_name', orderBy: 'duration DESC', window: { from: 1000, to: 5000 }, saved: 12, groupBy: '', denoise: false,
  };
  assert.deepEqual(parseState(serializeState(s)), s);
  const p = { ...DEFAULT_STATE, window: { preset: '7d' as const } };
  assert.deepEqual(parseState(serializeState(p)), p);
  assert.equal(parseState('?q=level:error').where, 'level:error', 'old q= links keep working');
});

test('bad URL values fall back to defaults', () => {
  assert.deepEqual(parseState('?source=x&t=99y&filters=nonsense&lang=pg'), DEFAULT_STATE);
  assert.deepEqual(parseState('?from=5&to=1').window, DEFAULT_STATE.window);
  assert.deepEqual(parseState('?filters=[{"field":"a","values":[]}]').filters, []);
});

test('presets: Live Tail is the last 15 minutes; labels follow ClickStack', () => {
  assert.deepEqual(resolveWindow({ preset: 'live' }, 1_000_000_000), { from: 1_000_000_000 - 900_000, to: 1_000_000_000 });
  assert.deepEqual(resolveWindow({ preset: '3h' }, 1e10), { from: 1e10 - 3 * 3600_000, to: 1e10 });
  assert.deepEqual(['live', '1m', '45m', '1h', '12h', '1d', '30d'].map((p) => presetLabel(p as never)),
    ['Live Tail', 'Last 1 minute', 'Last 45 minutes', 'Last 1 hour', 'Last 12 hours', 'Last 1 days', 'Last 30 days']);
  assert.equal(dorisTimeToMs('2026-11-04 05:00:00.250000'), Date.UTC(2026, 10, 4, 5, 0, 0, 250));
});

test('facet clicks toggle, flip, and narrow filters', () => {
  let f = toggleFilter([], 'service', 'cart', 'include');
  assert.deepEqual(f, [{ field: 'service', values: ['cart'] }]);
  f = toggleFilter(f, 'service', 'payment', 'include');
  assert.deepEqual(f, [{ field: 'service', values: ['cart', 'payment'] }]);
  f = toggleFilter(f, 'service', 'cart', 'include');
  assert.deepEqual(f, [{ field: 'service', values: ['payment'] }]);
  assert.deepEqual(toggleFilter(f, 'service', 'cart', 'exclude'), [{ field: 'service', values: ['cart'], exclude: true }]);
  assert.deepEqual(toggleFilter([...f, { field: 'level', values: ['ERROR'] }], 'service', 'shipping', 'only'),
    [{ field: 'level', values: ['ERROR'] }, { field: 'service', values: ['shipping'] }]);
  assert.deepEqual(toggleFilter(f, 'service', 'payment', 'include'), []);
});

test('patterns group lines that differ in numbers, ids and hosts', () => {
  assert.equal(template('upstream cart timeout after 1405 ms'), 'upstream cart timeout after <num> ms');
  assert.equal(template('payment declined for order f43e988f-51a4-5259-e971-c3d7aa734534: card expired'),
    'payment declined for order <uuid>: card expired');
  assert.equal(template('connection refused to redis-7.cache:6379'), 'connection refused to redis-<num>.cache:<num>');
  const rows = [
    { body: 'timeout after 5 ms', severity_text: 'ERROR', t: 0 }, { body: 'timeout after 17 ms', severity_text: 'ERROR', t: 90 },
    { body: 'cache hit for key product:12', severity_text: 'INFO', t: 50 },
  ];
  const p = minePatterns(rows, 'body', 'severity_text', 0, 100, 4, (r) => Number(r.t));
  assert.deepEqual(p.map((x) => [x.pattern, x.count, x.level, x.trend]), [
    ['timeout after <num> ms', 2, 'ERROR', [1, 0, 0, 1]],
    ['cache hit for key product:<num>', 1, 'INFO', [0, 0, 1, 0]],
  ]);
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

test('service map layout: callers left of callees, depth by longest call chain', async () => {
  const { layers } = await import('../src/lib/graph.ts');
  const edges = [
    { src: 'frontend', dst: 'checkout' }, { src: 'frontend', dst: 'cart' }, { src: 'checkout', dst: 'payment' },
    { src: 'checkout', dst: 'cart' }, { src: 'frontend', dst: 'catalog' },
  ];
  assert.deepEqual(layers(['payment', 'cart', 'frontend', 'checkout', 'catalog'], edges),
    [['frontend'], ['catalog', 'checkout'], ['cart', 'payment']]);
  // A cycle does not loop forever.
  assert.deepEqual(layers(['a', 'b'], [{ src: 'a', dst: 'b' }, { src: 'b', dst: 'a' }]).flat().sort(), ['a', 'b']);
});

test('event deltas: selection narrows time and duration band; differences rank fields', async () => {
  const { selectionSpec, compareFacets, bandLow } = await import('../src/lib/deltas.ts');
  assert.equal(bandLow(16), 10_000);
  assert.equal(bandLow(17), 17_783);
  const spec = { source: 'traces' as const, where: 'service:frontend', language: 'lucene' as const, filters: [], range: { from: 0, to: 100 } };
  assert.deepEqual(selectionSpec(spec, { from: 10, to: 20, bLo: 16, bHi: 17 }),
    { ...spec, where: '(service:frontend) duration:[10000 TO 31623}', range: { from: 10, to: 20 } });
  assert.equal(selectionSpec({ ...spec, where: '', language: 'sql' }, { from: 0, to: 1, bLo: 16, bHi: 16 }).where,
    'duration >= 10000 AND duration < 17783');
  const sel = { sampled: 10, facets: [{ field: 'http.route', values: [{ v: '/checkout', n: 9 }, { v: '/', n: 1 }] }, { field: 'kind', values: [{ v: 'server', n: 10 }] }] };
  const bg = { sampled: 100, facets: [{ field: 'http.route', values: [{ v: '/', n: 80 }, { v: '/checkout', n: 20 }] }, { field: 'kind', values: [{ v: 'server', n: 100 }] }] };
  const d = compareFacets(sel, bg);
  assert.deepEqual(d.map((x) => x.field), ['http.route'], 'a field with no difference is dropped');
  assert.deepEqual(d[0]!.values.map((v) => [v.v, v.sel, v.bg]), [['/checkout', 0.9, 0.2], ['/', 0.1, 0.8]]);
});

test('natural-language time ranges', async () => {
  const { parseNaturalRange } = await import('../src/lib/nltime.ts');
  const now = new Date(2026, 10, 5, 15, 30).getTime(); // Thursday 15:30 local
  const H = 3600_000;
  assert.deepEqual(parseNaturalRange('last 2 hours', now), { from: now - 2 * H, to: now });
  assert.deepEqual(parseNaturalRange('Past 30m', now), { from: now - 30 * 60_000, to: now });
  assert.deepEqual(parseNaturalRange('3h ago', now), { from: now - 3 * H, to: now });
  assert.deepEqual(parseNaturalRange('since 10 minutes ago', now), { from: now - 10 * 60_000, to: now });
  assert.deepEqual(parseNaturalRange('last hour', now), { from: now - H, to: now });
  const midnight = new Date(2026, 10, 5).getTime();
  assert.deepEqual(parseNaturalRange('today', now), { from: midnight, to: now });
  assert.deepEqual(parseNaturalRange('yesterday', now), { from: midnight - 24 * H, to: midnight });
  const monday = new Date(2026, 10, 2).getTime();
  assert.deepEqual(parseNaturalRange('this week', now), { from: monday, to: now });
  assert.deepEqual(parseNaturalRange('last week', now), { from: monday - 7 * 24 * H, to: monday });
  assert.deepEqual(parseNaturalRange('2026-11-04 10:00 to 12:30', now),
    { from: new Date(2026, 10, 4, 10).getTime(), to: new Date(2026, 10, 4, 12, 30).getTime() });
  assert.equal(parseNaturalRange('sometime soon', now), null);
  assert.equal(parseNaturalRange('last 5 parsecs', now), null);
});

test('csv: header from labels, RFC 4180 quoting, objects as JSON', async () => {
  const { toCsv } = await import('../src/lib/csv.ts');
  assert.equal(toCsv([{ key: 'a', label: 'a' }, { key: 'b', label: 'round(d, 1)' }], [{ a: 'x,"y"', b: 1 }, { a: null, b: { k: 1 } }]),
    'a,"round(d, 1)"\r\n"x,""y""",1\r\n,"{""k"":1}"\r\n');
});

test('query history: newest first, no duplicates, capped', async () => {
  const { pushHistory } = await import('../src/lib/history.ts');
  assert.deepEqual(pushHistory(['b', 'a'], ' a '), ['a', 'b']);
  assert.deepEqual(pushHistory(['a'], '  '), ['a']);
  assert.deepEqual(pushHistory(['3', '2', '1'], '4', 3), ['4', '3', '2']);
});

test('denoise: templates of at least 5% of a big enough sample', async () => {
  const { noisyTemplates, template } = await import('../src/lib/patterns.ts');
  const rows = [
    ...Array.from({ length: 90 }, (_, i) => ({ body: `GET /health took ${i}ms` })),
    ...Array.from({ length: 8 }, (_, i) => ({ body: `cart ${i} updated` })),
    { body: 'payment declined for order 17' }, { body: 'disk full' },
  ];
  const noisy = noisyTemplates(rows, 'body');
  assert.ok(noisy.has(template('GET /health took 3ms')));
  assert.ok(noisy.has(template('cart 1 updated')));
  assert.ok(!noisy.has(template('disk full')));
  assert.equal(noisyTemplates(rows.slice(0, 10), 'body').size, 0, 'too small a sample hides nothing');
});

test('state: groupBy and denoise round-trip through the URL', async () => {
  const { parseState, serializeState, DEFAULT_STATE } = await import('../src/lib/state.ts');
  const s = { ...DEFAULT_STATE, groupBy: 'service_name', denoise: true };
  assert.deepEqual(parseState(serializeState(s)), s);
  assert.deepEqual(parseState(serializeState(DEFAULT_STATE)), DEFAULT_STATE);
});

test('sdk sessions: kept while active, new after 30 minutes idle or 4 hours; the user carries over', async () => {
  const { touchSession, IDLE_MS, MAX_MS } = await import('../src/sdk/core.ts');
  let n = 0;
  const id = () => `id${++n}`;
  const a = touchSession(null, 1000, id);
  assert.deepEqual([a.state.id, a.rotated], ['id1', false]);
  const b = touchSession({ ...a.state, seq: 3, user: { id: 'u' } }, 1000 + IDLE_MS - 1, id);
  assert.deepEqual([b.state.id, b.state.seq, b.rotated], ['id1', 3, false]);
  const c = touchSession(b.state, b.state.lastActive + IDLE_MS, id);
  assert.deepEqual([c.state.id, c.state.seq, c.rotated, c.state.user], ['id2', 0, true, { id: 'u' }]);
  let s = touchSession(null, 0, id).state;
  for (let t = 60_000; t < MAX_MS; t += 600_000) s = touchSession(s, t, id).state;
  assert.notEqual(touchSession(s, MAX_MS, id).state.id, s.id, 'a busy session still ends after 4 hours');
});

test('sdk: clicked elements are described without form field text', async () => {
  const { describeElement } = await import('../src/sdk/core.ts');
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, getAttribute: () => null, ...extra });
  assert.equal(describeElement(el('BUTTON', { id: 'buy', className: 'btn primary big', textContent: '  Buy\n now ' })), 'button#buy.btn.primary "Buy now"');
  assert.equal(describeElement(el('INPUT', { id: 'card', textContent: '4111 1111' })), 'input#card');
  assert.equal(describeElement({ tagName: 'A', getAttribute: (n: string) => (n === 'aria-label' ? 'Cart' : null), textContent: '3' }), 'a "Cart"');
});

test('sdk batch: replay chunks under the body size, each its own seq; events ride with the first', async () => {
  const { Batch, MAX_BODY_CHARS } = await import('../src/sdk/core.ts');
  const b = new Batch();
  const big = 'x'.repeat(MAX_BODY_CHARS / 2 + 10);
  for (let i = 0; i < 3; i++) b.addReplay({ timestamp: 100 + i, data: big } as never);
  b.addEvent({ t: 5, type: 'click', message: 'a' });
  let seq = 7;
  const bodies = b.take(() => seq++);
  assert.deepEqual(bodies.map((x) => [x.replay.map((r) => [r.seq, r.t, r.events.length]), x.events.length]),
    [[[[7, 100, 1]], 1], [[[8, 101, 1]], 0], [[[9, 102, 1]], 0]]);
  assert.ok(b.empty);
  for (let i = 0; i < 2500; i++) b.addEvent({ t: i, type: 'network' });
  assert.deepEqual(b.take(() => 0).map((x) => [x.replay.length, x.events.length]), [[0, 1000], [0, 1000], [0, 500]]);
});

test('sdk trace propagation: W3C traceparent, own origin always, others only when listed', async () => {
  const { newTraceparent, parseTraceparent, shouldPropagate } = await import('../src/sdk/core.ts');
  const t = newTraceparent();
  assert.match(t.header, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.deepEqual(parseTraceparent(t.header), { traceId: t.traceId, spanId: t.spanId });
  assert.equal(parseTraceparent('00-00000000000000000000000000000000-0000000000000001-01'), null, 'all-zero trace id is invalid');
  assert.equal(parseTraceparent('garbage'), null);
  const page = 'https://shop.example.com';
  assert.equal(shouldPropagate('/api/cart', page, []), true);
  assert.equal(shouldPropagate('https://shop.example.com/x', page, []), true);
  assert.equal(shouldPropagate('https://api.example.com/x', page, []), false);
  assert.equal(shouldPropagate('https://api.example.com/x', page, ['https://api.example.com/']), true);
  assert.equal(shouldPropagate('https://cdn.other.com/x', page, [/\.example\.com\//]), false);
  assert.equal(shouldPropagate('https://pay.example.com/x', page, [/\.example\.com\//]), true);
});

test('sdk: clicks inside editable, masked or blocked parts carry no text', async () => {
  const { describeElement } = await import('../src/sdk/core.ts');
  const p = { tagName: 'P', className: 'para', getAttribute: (n: string) => (n === 'aria-label' ? 'Note' : null), textContent: 'my private note' };
  assert.equal(describeElement(p), 'p.para "Note"');
  assert.equal(describeElement(p, true), 'p.para');
});
