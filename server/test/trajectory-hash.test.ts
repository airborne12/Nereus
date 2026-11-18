// Hashes and small helpers of the trajectory model.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiMessageHash, argsHash, blockHash, canonicalJson } from '../src/semantics/trajectory/hash.ts';
import { dorisMs, dorisTime } from '../src/semantics/trajectory/model.ts';
import { resourceOf } from '../src/semantics/trajectory/resource.ts';

test('canonicalJson: sorted keys, no spaces, undefined left out', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }], u: undefined }), '{"a":[{"c":"x","d":2}],"b":1}');
  assert.equal(canonicalJson('é'), '"é"');
  assert.equal(canonicalJson(null), 'null');
});

test('apiMessageHash is the hash Claude Code writes in its request log', () => {
  // Reference value computed with Python: sha256(json.dumps(m, sort_keys=True, separators=(",", ":"), ensure_ascii=False)).
  assert.equal(apiMessageHash({ role: 'user', content: [{ type: 'text', text: 'héllo 中' }] }),
    '27f42ed5e803463b808df1accb72b7ef2ad008dfafa3435eccd5cc080313a87f');
});

test('blockHash separates role, kind and content; argsHash is 32 hex characters', () => {
  assert.notEqual(blockHash('user', 'text', 'ok', null, null), blockHash('assistant', 'text', 'ok', null, null));
  assert.notEqual(blockHash('user', 'text', 'ok', null, null), blockHash('user', 'attachment', 'ok', null, null));
  assert.equal(blockHash('assistant', 'tool_use', 'Read', { b: 1, a: 2 }, 't1'), blockHash('assistant', 'tool_use', 'Read', { a: 2, b: 1 }, 't1'));
  assert.notEqual(blockHash('assistant', 'tool_use', 'Read', { a: 2 }, 't1'), blockHash('assistant', 'tool_use', 'Read', { a: 2 }, 't2'), 'two identical calls are two blocks');
  assert.match(argsHash('Read', { file_path: 'a' }), /^[0-9a-f]{32}$/);
  assert.equal(argsHash('Read', { file_path: 'a' }), argsHash('Read', { file_path: 'a' }));
  assert.notEqual(argsHash('Read', { file_path: 'a' }), argsHash('Write', { file_path: 'a' }));
});

test('dorisTime and dorisMs convert between ISO 8601 and DATETIME(6)', () => {
  assert.equal(dorisTime('2026-11-17T10:00:03.250Z'), '2026-11-17 10:00:03.250000');
  assert.equal(dorisMs('2026-11-17 10:00:03.250000'), Date.parse('2026-11-17T10:00:03.250Z'));
});

test('resourceOf picks the object a tool acts on', () => {
  assert.equal(resourceOf('Read', { file_path: 'src/a.ts', limit: 5 }), 'src/a.ts');
  assert.equal(resourceOf('NotebookEdit', { notebook_path: 'n.ipynb' }), 'n.ipynb');
  assert.equal(resourceOf('Grep', { pattern: 'utc', path: 'src' }), 'src');
  assert.equal(resourceOf('Grep', { pattern: 'utc' }), 'utc');
  assert.equal(resourceOf('WebFetch', { url: 'https://x' }), 'https://x');
  assert.equal(resourceOf('Bash', { command: 'pytest -q' }), 'pytest -q');
  assert.equal(resourceOf('Agent', { prompt: 'x' }), null);
  assert.equal(resourceOf('Read', 'not an object'), null);
});
