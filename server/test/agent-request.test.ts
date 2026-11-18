// Reading the agent routes' parameters, and VARIANT columns parsed from JSON text (no database).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intParam, parsed, tableRequest } from '../src/api/agents/request.ts';

const url = (q: string) => new URL(`http://x/api/agents/sessions?${q}`);

test('tableRequest: range, search, repeated conditions, sort, paging and defaults', () => {
  const r = tableRequest(url('from=2026-11-17&to=2026-11-18&q=a%20b&f=steps:ge:7&f=model:contains:opus&sort=steps&dir=asc&limit=50&offset=100'));
  assert.deepEqual(r, {
    from: '2026-11-17', to: '2026-11-18', q: 'a b', sort: 'steps', dir: 'asc', limit: 50, offset: 100,
    conditions: [{ column: 'steps', op: 'ge', value: '7' }, { column: 'model', op: 'contains', value: 'opus' }],
  });
  const d = tableRequest(url('from=2026-11-17&to=2026-11-18'));
  assert.deepEqual([d.q, d.conditions, d.sort, d.dir, d.limit, d.offset], ['', [], undefined, undefined, 100, 0]);
});

test('tableRequest refuses a missing range, a bad direction and limits out of bounds', () => {
  assert.throws(() => tableRequest(url('to=2026-11-18')), /'from' and 'to' are required/);
  assert.throws(() => tableRequest(url('from=a&to=b&dir=up')), /'dir' must be asc or desc/);
  assert.throws(() => tableRequest(url('from=a&to=b&limit=0')), /'limit' must be an integer from 1 to 1000/);
  assert.throws(() => tableRequest(url('from=a&to=b&limit=1001')), /'limit'/);
  assert.throws(() => intParam(url('offset=-1'), 'offset', 0), /'offset'/);
});

test('parsed: VARIANT and ARRAY text becomes values; other columns and non-JSON stay', () => {
  assert.deepEqual(parsed([{ args: '{"a":1}', tool_names: '["Read"]', attrs: 'not json', text: '{"x":1}' }]),
    [{ args: { a: 1 }, tool_names: ['Read'], attrs: 'not json', text: '{"x":1}' }]);
});
