// Sequence patterns and "what happens next" on a live Doris, against an independent computation
// (spec 11): the events are read back with plain statements and matched here by a loop, and the
// compiled statements must find the same matches and the same tree. Skipped unless DORIS_TEST=1.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { importFile } from '../src/cli/import-transcripts.ts';
import { Doris, configFromEnv } from '../src/db/doris.ts';
import { streamLoad, streamLoadConfigFromEnv } from '../src/db/stream-load.ts';
import { matchSql } from '../src/semantics/sequences/match.ts';
import { parsePattern, type Step, type StepKind } from '../src/semantics/sequences/pattern.ts';
import { KIDS, parseStart, pathsSql, pathTree, RARE, toolsSql, type Other, type PathNode, type PathRow, type PathTree } from '../src/semantics/sequences/paths.ts';
import { writeFixture } from './fixtures/claude-transcript.ts';
import { SEQ_A, writeSequences } from './fixtures/sequence-transcript.ts';
import { applySchemaFile } from './schema-helper.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_sequences_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const DAY = { from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' };
/** A stretch inside the generated sessions, so matches are cut at both ends. */
const PART = { from: '2026-11-17T09:01:30Z', to: '2026-11-17T09:04:00Z' };
let doris: Doris;
let dir = '';

interface Ev { session_id: string; seq: number; ts: string; kind: StepKind; name: string; status: string; target: string }
let all: Ev[] = [];

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  await doris.query(`CREATE DATABASE ${db}`);
  await applySchemaFile(doris, '003_agent_tables.sql', db);
  const cfg = streamLoadConfigFromEnv();
  const load = (t: string, l: string, r: readonly object[]) => streamLoad(cfg, db, t, l, r);
  dir = mkdtempSync(join(tmpdir(), 'nereus-sequences-'));
  for (const file of [writeFixture(dir), ...writeSequences(dir)]) await importFile(file, { doris, db, load });
  all = await readEvents();
});
after(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (!doris) return;
  try { await doris.query(`DROP DATABASE IF EXISTS ${db} FORCE`); } finally { await doris.close(); }
});

/** The events of every session in order, with their targets worked out here from the blocks. */
async function readEvents(): Promise<Ev[]> {
  const events = await doris.query(`SELECT session_id, seq, ts, kind, name, status, resource, CAST(args AS STRING) AS args, msg_seq, stop_reason FROM ${db}.agent_events ORDER BY session_id, seq`);
  const blocks = await doris.query(`SELECT session_id, msg_seq, event_seq, msg_role, text FROM ${db}.agent_messages WHERE kind = 'text' ORDER BY session_id, msg_seq`);
  const KIND: Record<string, StepKind> = { tool_call: 'call', user_input: 'user', compaction: 'compaction', llm_call: 'reply' };
  return events
    .filter((e) => e.kind === 'user_input' || e.kind === 'tool_call' || e.kind === 'compaction' || (e.kind === 'llm_call' && e.stop_reason === 'end_turn'))
    .map((e): Ev => {
      const own = blocks.find((b) => b.session_id === e.session_id && Number(b.msg_seq) === Number(e.msg_seq));
      const said = blocks.filter((b) => b.session_id === e.session_id && b.msg_role === 'assistant' && Number(b.event_seq) === Number(e.seq)).map((b) => String(b.text));
      const text = own ? String(own.text) : e.kind === 'llm_call' && said.length ? said.join('\n') : '';
      const target = e.kind === 'tool_call' ? String(e.resource ?? e.args ?? '') : e.kind === 'compaction' ? '' : text;
      return { session_id: String(e.session_id), seq: Number(e.seq), ts: String(e.ts), kind: KIND[String(e.kind)]!, name: String(e.name ?? ''), status: String(e.status ?? ''), target };
    });
}

const stamp = (iso: string) => iso.replace('T', ' ').replace('Z', '');
/** The events of a range, per session, in order. */
function streams(range: { from: string; to: string }): Ev[][] {
  const inRange = all.filter((e) => e.ts >= stamp(range.from) && e.ts < stamp(range.to));
  return [...new Set(inRange.map((e) => e.session_id))].map((id) => inRange.filter((e) => e.session_id === id));
}

const meets = (s: Step, e: Ev, taken: readonly Ev[]): boolean => s.kind === e.kind
  && (!s.tool || e.name === s.tool)
  && (!s.status || e.status === (s.status === 'failed' ? 'error' : 'ok'))
  && (!s.has || e.target.toLowerCase().includes(s.has))
  && (!s.any || s.any.some((w) => e.target.toLowerCase().includes(w)))
  && (!s.same || (e.target !== '' && e.target === taken[s.same - 1]!.target));

/** The matches in one session: every event that meets step 1 starts at most one, each further step takes the nearest event. */
function find(pattern: readonly Step[], events: readonly Ev[]): { taken: Ev[]; span: number }[] {
  return events.flatMap((first, at) => {
    if (!meets(pattern[0]!, first, [])) return [];
    const taken = [first];
    const where = [at];
    for (let j = 1; j < pattern.length; j += 1) {
      const from = where[j - 1]! + 1;
      const end = pattern[j]!.link === 'next' ? Math.min(from + 1, events.length) : events.length;
      let hit = -1;
      for (let i = from; i < end && hit < 0; i += 1) if (meets(pattern[j]!, events[i]!, taken)) hit = i;
      if (hit < 0) return [];
      taken.push(events[hit]!);
      where.push(hit);
    }
    return [{ taken, span: where[where.length - 1]! - where[0]! + 1 }];
  });
}

const TOOLS = ['Read', 'Edit', 'Bash', 'Grep'];
const LINKS = ['next', 'later'];
const PATTERNS: unknown[][] = [
  ...TOOLS.map((t) => [{ tool: t }]),
  [{}], [{ status: 'failed' }], [{ status: 'ok', has: 'PYTEST' }], [{ kind: 'user' }], [{ kind: 'reply' }], [{ kind: 'compaction' }],
  [{ kind: 'user', has: 'yes' }], [{ kind: 'reply', has: 'should i' }], [{ tool: 'Agent', has: 'clock helpers' }],
  ...TOOLS.flatMap((a) => TOOLS.flatMap((b) => LINKS.map((link) => [{ tool: a }, { tool: b, link }]))),
  ...TOOLS.flatMap((a) => TOOLS.flatMap((b) => LINKS.flatMap((l1) => LINKS.map((l2) => [{ tool: a }, { tool: b, link: l1 }, { tool: 'Bash', link: l2 }])))),
  ...TOOLS.flatMap((a) => LINKS.flatMap((l1) => LINKS.map((l2) => [{ tool: a }, { tool: 'Bash', status: 'failed', link: l1 }, { tool: a, same: 1, link: l2 }]))),
  ...LINKS.flatMap((l1) => LINKS.flatMap((l2) => [
    [{ tool: 'Edit' }, { tool: 'Bash', status: 'failed', has: 'pytest', link: l1 }, { tool: 'Edit', same: 1, link: l2 }],
    [{ tool: 'Grep' }, { tool: 'Read', link: l1 }, { tool: 'Edit', same: 2, link: l2 }],
    [{ kind: 'reply', has: 'should i' }, { kind: 'user', link: l1 }, { tool: 'Bash', link: l2 }],
    [{ kind: 'user' }, { link: l1 }, { kind: 'reply', link: l2 }],
    [{ kind: 'user', has: 'yes' }, { kind: 'user', same: 1, link: l1 }, { tool: 'Read', link: l2 }],
    [{ kind: 'compaction' }, { kind: 'user', link: l1 }, { status: 'ok', link: l2 }],
    [{ tool: 'Read' }, { tool: 'Edit', same: 1, link: l1 }, { tool: 'Bash', link: l2 }, { tool: 'Read', same: 1, link: 'later' }],
  ])),
  [{ tool: 'Edit' }, { tool: 'Bash', status: 'failed', has: 'test', link: 'next' }, { tool: 'Edit', same: 1, link: 'next' }],
  [{ tool: 'Grep' }, { tool: 'Read', link: 'later' }, { tool: 'Edit', link: 'later' }, { tool: 'Bash', status: 'ok', has: 'test', link: 'later' }],
  [{ kind: 'user' }, { link: 'next' }, { link: 'later' }, { tool: 'Bash', link: 'later' }, { kind: 'reply', link: 'later' }, { kind: 'user', link: 'next' }],
  [{ tool: 'Bash', any: ['pytest', 'git'] }, { tool: 'Edit', any: ['zone', 'clock_test'], link: 'later' }],
];

/** Runs `job` over `items`, eight at a time. */
async function each<T>(items: readonly T[], job: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += 8) await Promise.all(items.slice(i, i + 8).map(job));
}

async function compare(raw: unknown[], range: { from: string; to: string }): Promise<number> {
  const pattern = parsePattern(raw);
  const expected = streams(range).flatMap((events) => find(pattern, events));
  const { rows, total, matches } = matchSql(db, { ...range, pattern, sort: 'time', dir: 'asc', limit: 1000, offset: 0 });
  const [got, counts] = await Promise.all([doris.query(rows.sql), doris.query(total.sql)]);
  const label = JSON.stringify(raw);
  const line = (session: string, seqs: number[], span: number) => `${session} ${seqs.join(',')} span ${span}`;
  assert.deepEqual(
    matches(got).map((m) => line(m.session_id, m.steps.map((s) => s.seq), m.span)).sort(),
    expected.map((m) => line(m.taken[0]!.session_id, m.taken.map((e) => e.seq), m.span)).sort(),
    label,
  );
  assert.deepEqual([Number(counts[0]!.matches), Number(counts[0]!.sessions)], [expected.length, new Set(expected.map((m) => m.taken[0]!.session_id)).size], label);
  return expected.length;
}

test('every pattern finds the matches a loop over the events finds', { skip: !enabled }, async () => {
  assert.ok(PATTERNS.length >= 150, `${PATTERNS.length} patterns`);
  let found = 0;
  let empty = 0;
  await each(PATTERNS, async (p) => {
    const n = await compare(p, DAY);
    found += n;
    if (n === 0) empty += 1;
  });
  // The generated sessions must exercise the patterns, not leave most of them without a match.
  assert.ok(found > 2000 && empty < PATTERNS.length / 4, `${found} matches, ${empty} patterns without one`);
});

test('a time range cuts the sessions before matching', { skip: !enabled }, async () => {
  await each(PATTERNS.filter((_, i) => i % 5 === 0), async (p) => { await compare(p, PART); });
});

test('a match carries its events as the page shows them', { skip: !enabled }, async () => {
  const pattern = parsePattern([{ kind: 'reply', has: 'should i' }, { kind: 'user', link: 'next' }, { tool: 'Bash', link: 'later' }]);
  const { rows, matches } = matchSql(db, { ...DAY, pattern, sort: 'time', dir: 'asc', limit: 1, offset: 0 });
  const m = matches(await doris.query(rows.sql))[0]!;
  const events = all.filter((e) => e.session_id === m.session_id);
  assert.deepEqual(m.steps.map((s) => [s.kind, s.what, s.target]), m.steps.map((s) => {
    const e = events.find((x) => x.seq === s.seq)!;
    return [e.kind, e.kind === 'call' ? e.name : e.kind === 'user' ? 'User input' : 'Reply', e.target];
  }));
  assert.match(m.steps[0]!.target, /should i/i);
  assert.equal(m.steps[0]!.call, null);
  assert.ok(m.steps[2]!.call !== null && m.steps[2]!.call < m.steps[2]!.seq, 'a tool call names the model call that issued it');
  assert.deepEqual([m.title, m.agent, m.root_id], [`Sequences ${m.session_id}`, 'main', m.session_id]);
});

test('the table sorts and pages in Doris', { skip: !enabled }, async () => {
  const pattern = parsePattern([{ tool: 'Read' }, { tool: 'Bash', link: 'later' }]);
  const run = async (extra: object) => {
    const { rows, matches } = matchSql(db, { ...DAY, pattern, limit: 1000, offset: 0, ...extra });
    return matches(await doris.query(rows.sql));
  };
  const bySpan = await run({ sort: 'span', dir: 'desc' });
  assert.ok(bySpan.length > 20);
  assert.deepEqual(bySpan.map((m) => m.span), [...bySpan.map((m) => m.span)].sort((a, b) => b - a));
  const byStep = await run({ sort: 'step2', dir: 'asc' });
  assert.deepEqual(byStep.map((m) => m.steps[1]!.ts), [...byStep.map((m) => m.steps[1]!.ts)].sort());
  const key = (m: { session_id: string; steps: { seq: number }[] }) => `${m.session_id}:${m.steps[0]!.seq}`;
  const page = await run({ sort: 'span', dir: 'desc', limit: 5, offset: 5 });
  assert.deepEqual(page.map(key), bySpan.slice(5, 10).map(key));
});

/** The tree of the drawing, worked out from the events by a loop. */
function expectedTree(start: string, depth: number, range: { from: string; to: string }): PathTree {
  const s = parseStart(start);
  const starts = (e: Ev) => (s.kind === 'failed' ? e.kind === 'call' && e.status === 'error' : s.kind === 'user' ? e.kind === 'user' : e.kind === 'call' && e.name === s.tool);
  const key = (e: Ev | undefined) => (!e ? '' : e.kind === 'call' ? `${e.status === 'error' ? 'f' : 'c'}:${e.name}` : `${{ user: 'u', reply: 'r', compaction: 'x' }[e.kind]}:`);
  const runs = streams(range).flatMap((events) => events.flatMap((e, i) => (starts(e) ? [Array.from({ length: depth - 1 }, (_, n) => key(events[i + 1 + n]))] : [])));
  const total = runs.length;
  const grow = (rows: string[][], level: number): { kids: PathNode[]; other: Other | null } => {
    const names = [...new Set(rows.map((r) => r[level]!))];
    const groups = names.map((name) => ({ name, rows: rows.filter((r) => r[level] === name) }))
      .sort((a, b) => b.rows.length - a.rows.length || (a.name < b.name ? -1 : 1));
    const own = groups.filter((g, i) => i < KIDS && g.rows.length * RARE >= total);
    const rest = groups.filter((g) => !own.includes(g));
    return {
      kids: own.map((g) => ({ key: g.name, times: g.rows.length, ...(g.name !== '' && level + 2 < depth ? grow(g.rows, level + 1) : { kids: [], other: null }) })),
      other: rest.length ? { count: rest.length, times: rest.reduce((n, g) => n + g.rows.length, 0) } : null,
    };
  };
  return { total, ...(total ? grow(runs, 0) : { kids: [], other: null }) };
}

test('the tree of what happens next equals a count by a loop', { skip: !enabled }, async () => {
  const cases = ['failed', 'user', ...TOOLS.map((t) => `tool:${t}`), 'tool:Agent', 'tool:Nothing'].flatMap((start) => [2, 3, 4].flatMap((depth) => [DAY, PART].map((range) => ({ start, depth, range }))));
  let drawn = 0;
  await each(cases, async ({ start, depth, range }) => {
    const rows = await doris.query(pathsSql(db, { ...range, start: parseStart(start), depth }).sql);
    const tree = pathTree(rows as unknown as PathRow[], depth);
    assert.deepEqual(tree, expectedTree(start, depth, range), `${start} depth ${depth} from ${range.from}`);
    drawn += tree.kids.length;
  });
  assert.ok(drawn > 60, `${drawn} branches drawn`);
  const full = pathTree(await doris.query(pathsSql(db, { ...DAY, start: { kind: 'tool', tool: 'Bash' }, depth: 4 }).sql) as unknown as PathRow[], 4);
  assert.ok(full.other && full.kids.length === KIDS && full.kids.some((k) => k.kids.some((g) => g.kids.length > 0)), 'the generated sessions fill four columns and an "other"');
});

test('the tools of the range', { skip: !enabled }, async () => {
  const rows = await doris.query(toolsSql(db, DAY.from, DAY.to).sql);
  const calls = all.filter((e) => e.kind === 'call');
  const expected = [...new Set(calls.map((e) => e.name))].map((name) => ({ name, calls: calls.filter((e) => e.name === name).length }))
    .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1));
  assert.deepEqual(rows.map((r) => ({ name: r.name, calls: Number(r.calls) })), expected);
  assert.ok(all.some((e) => e.session_id === SEQ_A && e.kind === 'compaction'));
});
