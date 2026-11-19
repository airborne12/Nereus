// The judge runner with stubs in place of Doris and the model: it reads what each step shows, asks
// the model a few steps at a time, hands each chunk on as rows of agent_judgments, stops before a
// chunk would go over the budget, and stops when no call of a chunk reached the model.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doris } from '../src/db/doris.ts';
import type { JudgeVersion } from '../src/semantics/judges/judge.ts';
import { ModelAccessError, type JudgeModel } from '../src/semantics/judges/model.ts';
import { judgeExcerpts, readSteps } from '../src/semantics/judges/runner.ts';

const V: JudgeVersion = {
  judge: 'edits-1a2b3c', version: 2, name: 'Edits of tests', pick: { tool: 'change', has: 'test', status: 'any' }, reads: { kind: 'step' },
  criterion: 'Is the test fitted to the output?', model: 'claude-haiku-5-5', createdAt: '2026-11-19 08:00:00.000000', createdBy: 'admin@example.com',
};
const row = (judged: number, seq: number, kind: string, text: string) => ({ session_id: 's-1', judged, seq, event_kind: kind, step: judged, name: kind === 'tool_call' ? 'Edit' : null, status: 'ok', target: 'tests/a_test.py', args: null, msg_seq: seq, kind: 'text', is_error: null, text });

function doris(rows: object[]) {
  const seen: string[] = [];
  return { d: { query: async (sql: string) => { seen.push(sql); return rows; } } as unknown as Doris, seen };
}
const read = (texts: string[]) => readSteps({ doris: doris(texts.map((t, i) => row(i + 1, i + 1, 'llm_call', t))).d, db: 'otel' }, V, texts.map((_, i) => ({ session_id: 's-1', seq: i + 1 })));

test('the steps are read with one statement, in the order asked', async () => {
  const { d, seen } = doris([row(5, 5, 'llm_call', 'Fixing it.'), row(9, 9, 'llm_call', 'Again.')]);
  const got = await readSteps({ doris: d, db: 'otel' }, V, [{ session_id: 's-1', seq: 9 }, { session_id: 's-1', seq: 5 }, { session_id: 's-1', seq: 77 }]);
  assert.deepEqual(got.map((x) => x.subject), ['s-1:9', 's-1:5'], 'a step without rows is left out');
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /\(j\.session_id = 's-1' AND j\.seq = 9\) OR \(j\.session_id = 's-1' AND j\.seq = 5\) OR/);
});

test('each excerpt is judged with the version criterion and model, a few at a time, and each chunk is handed on', async () => {
  const excerpts = await read(['Fixing it.', 'Changing the expected value.', 'Again.']);
  let running = 0;
  let most = 0;
  const asked: string[] = [];
  const model: JudgeModel = {
    async judge(m, criterion, excerpt) {
      running += 1;
      most = Math.max(most, running);
      asked.push(`${m}|${criterion}`);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return excerpt.includes('expected') ? { verdict: 'violates', reason: 'It changes the expected value.', inputTokens: 300, outputTokens: 20 } : { verdict: 'ok', reason: 'It fixes the code.', inputTokens: 200, outputTokens: 10 };
    },
  };
  const chunks: string[][] = [];
  const { rows, stopped } = await judgeExcerpts({ model, concurrency: 2, now: () => new Date('2026-11-19T09:00:00Z') }, V, excerpts, { onChunk: async (part) => { chunks.push(part.map((r) => r.subject)); } });
  assert.equal(most, 2);
  assert.equal(stopped, false);
  assert.deepEqual(chunks, [['s-1:1', 's-1:2'], ['s-1:3']]);
  assert.deepEqual([...new Set(asked)], ['claude-haiku-5-5|Is the test fitted to the output?']);
  assert.deepEqual(rows.map((r) => [r.subject, r.verdict, r.input_tokens]), [['s-1:1', 'ok', 200], ['s-1:2', 'violates', 300], ['s-1:3', 'ok', 200]]);
  assert.deepEqual(rows[1], {
    judge: 'edits-1a2b3c', subject: 's-1:2', judge_version: 2, version: 1, session_id: 's-1', seq: 2, verdict: 'violates', state: null, evidence: null, prev_version: null,
    reason: 'It changes the expected value.', input_seqs: [2], input_hash: excerpts[1]!.hash, model: 'claude-haiku-5-5', input_tokens: 300, output_tokens: 20, judged_at: '2026-11-19 09:00:00.000000',
  });
});

test('the budget is checked before each chunk against the tokens the model really took', async () => {
  const excerpts = await read(['a', 'b', 'c', 'd', 'e', 'f']);
  const model: JudgeModel = { judge: async () => ({ verdict: 'ok', reason: 'fine', inputTokens: 10_000, outputTokens: 5 }) };
  const { rows, stopped } = await judgeExcerpts({ model, concurrency: 2 }, V, excerpts, { budget: 25_000 });
  // The first chunk is estimated small and takes 20,000; the second would go over.
  assert.deepEqual([rows.length, stopped], [2, true]);
  const none = await judgeExcerpts({ model, concurrency: 2 }, V, excerpts, { budget: 10 });
  assert.deepEqual([none.rows.length, none.stopped], [0, true], 'a budget smaller than one chunk judges nothing');
});

test('a chunk in which no call reached the model stops the judging, and nothing of it is handed on', async () => {
  const excerpts = await read(['a', 'b', 'c', 'd']);
  let calls = 0;
  const flaky: JudgeModel = {
    judge: async () => {
      calls += 1;
      return calls <= 2 ? { verdict: 'ok', reason: 'fine', inputTokens: 100, outputTokens: 5 } : { verdict: 'unsure', reason: 'The model could not be reached: 529 overloaded', inputTokens: 0, outputTokens: 0 };
    },
  };
  const handed: string[] = [];
  await assert.rejects(judgeExcerpts({ model: flaky, concurrency: 2 }, V, excerpts, { onChunk: async (part) => { handed.push(...part.map((r) => r.subject)); } }),
    (e: Error) => e instanceof ModelAccessError && e.message === 'No call reached the model: The model could not be reached: 529 overloaded');
  assert.deepEqual(handed, ['s-1:1', 's-1:2']);
  // One failure among answers that reached the model is a verdict like any other.
  const one: JudgeModel = { judge: async (_m, _c, x) => (x.includes('b') ? { verdict: 'unsure', reason: 'The model could not be reached: x', inputTokens: 0, outputTokens: 0 } : { verdict: 'ok', reason: 'fine', inputTokens: 100, outputTokens: 5 }) };
  assert.equal((await judgeExcerpts({ model: one, concurrency: 2 }, V, excerpts)).rows.length, 4);
});

test('a model that cannot be used stops the judging', async () => {
  const excerpts = await read(['x']);
  const model: JudgeModel = { judge: async () => { throw new ModelAccessError('The model cannot be used: bad key'); } };
  await assert.rejects(judgeExcerpts({ model }, V, excerpts), /bad key/);
});
