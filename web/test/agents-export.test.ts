// What the export dialog says about a file before it is read (no browser).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countsText, formatsOf, previewText, recordsOf } from '../src/lib/agents/export.ts';

test('the export dialog: formats by page, sizes in words, and a preview with long values cut', () => {
  assert.deepEqual(formatsOf('sessions').map((f) => f.id), ['csv', 'jsonl']);
  assert.deepEqual(formatsOf('steps').map((f) => f.id), ['csv']);
  assert.equal(countsText('csv', { rows: 12, bytes: 2970 }), '12 rows');
  assert.equal(countsText('jsonl', { sessions: '2', parts: '3', blocks: '19', bytes: '1258291' }), '3 lines at most · 19 message blocks · 1.2 MB');
  assert.deepEqual([recordsOf('csv', { rows: 0 }), recordsOf('jsonl', { parts: '3' })], [0, 3]);
  assert.equal(previewText('a,b\n1,2\n'), 'a,b\n1,2\n');
  const lines = previewText([{ session_id: 's', messages: [{ role: 'user', content: 'x'.repeat(200) }] }, { session_id: 't', messages: [] }]).split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).messages[0].content, `${'x'.repeat(160)}…`);
});
