// Session ingestion: validation, payload splitting and INSERT batching (no database).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertSql, PART_CHARS, sessionRows, splitParts } from '../src/sessions/ingest.ts';

const now = Date.parse('2026-11-05T10:00:00Z');

test('splitParts: bounded parts that join back, never cutting a surrogate pair', () => {
  const s = 'a'.repeat(9) + '😀' + 'b'.repeat(5);
  const parts = splitParts(s, 10);
  assert.equal(parts.join(''), s);
  assert.ok(parts.every((p) => p.length <= 10));
  assert.equal(parts[0], 'a'.repeat(9), 'the pair moves to the next part');
  assert.deepEqual(splitParts(''), ['']);
});

test('sessionRows: replay chunks split into parts, events typed, user on every row', () => {
  const big = Array.from({ length: 3 }, (_, i) => ({ type: 2, timestamp: now, data: { html: 'x'.repeat(PART_CHARS) + i } }));
  const rows = sessionRows({
    sessionId: 's_12345678', service: 'shop', userAgent: 'UA', user: { id: 'u1', email: 'ada@example.com', name: 'Ada' },
    replay: [{ seq: 4, t: now, events: big }],
    events: [{ t: now + 5, type: 'click', url: 'https://shop/', message: 'button#buy "Buy"', attributes: { x: 1 } },
      { t: now + 9, type: 'error', message: 'TypeError: x is undefined' }],
  }, now);
  const replay = rows.filter((r) => r.kind === 'replay');
  assert.ok(replay.length >= 2);
  assert.deepEqual(replay.map((r) => r.part), replay.map((_, i) => i));
  assert.deepEqual(JSON.parse(replay.map((r) => r.payload).join('')), big);
  const ev = rows.filter((r) => r.kind === 'event');
  assert.deepEqual(ev.map((r) => [r.event_type, r.timestamp, r.attributes]), [
    ['click', '2026-11-05 10:00:00.005', '{"x":1}'], ['error', '2026-11-05 10:00:00.009', null]]);
  assert.ok(rows.every((r) => r.user_email === 'ada@example.com' && r.session_id === 's_12345678' && r.service_name === 'shop'));
});

test('sessionRows: rejects what does not fit', () => {
  const ok = { sessionId: 's_12345678' };
  const bad = (b: Record<string, unknown>, re: RegExp) => assert.throws(() => sessionRows({ ...ok, ...b }, now), re);
  bad({ sessionId: 'x' }, /sessionId/);
  bad({ sessionId: "a'; DROP TABLE t; --" }, /sessionId/);
  bad({ events: [{ t: now, type: 'keylog' }] }, /event type/);
  bad({ events: [{ t: now + 3 * 86_400_000, type: 'click' }] }, /a day away/);
  bad({ events: [{ t: '2026', type: 'click' }] }, /epoch/);
  bad({ replay: [{ seq: -1, t: now, events: [{}] }] }, /seq/);
  bad({ replay: [{ seq: 1, t: now, events: [] }] }, /rrweb events/);
  bad({ events: [{ t: now, type: 'custom', attributes: { a: 'x'.repeat(20_000) } }] }, /too large/);
  bad({ events: Array.from({ length: 1001 }, () => ({ t: now, type: 'click' })) }, /at most 1000/);
  assert.equal(sessionRows({ ...ok, events: [{ t: now, type: 'custom', message: 'm'.repeat(5000) }] }, now)[0]!.message!.length, 2000);
});

test('insertSql: values escaped, statements batched by size', () => {
  const rows = sessionRows({ sessionId: 's_12345678', events: Array.from({ length: 30 }, (_, i) => ({ t: now, type: 'custom', message: `it's \\ ${i}` })) }, now);
  const sql = insertSql('db.otel_sessions', rows, 1000);
  assert.ok(sql.length > 1);
  assert.ok(sql.every((s) => s.startsWith('INSERT INTO db.otel_sessions (session_id, timestamp,')));
  assert.match(sql[0]!, /'it\\'s \\\\ 0'/);
  assert.equal(sql.join(' ').match(/\('s_12345678'/g)!.length, 30);
  const withAttrs = insertSql('t', sessionRows({ sessionId: 's_12345678', events: [{ t: now, type: 'network', attributes: { status: 500 } }] }, now))[0]!;
  assert.ok(withAttrs.includes(`CAST(CAST('{\\"status\\":500}' AS JSON) AS VARIANT)`), withAttrs);
});
