// Imports point downwards only: db/ imports nothing above it; semantics/ imports no route, control,
// rum or command code; the normaliser and the adapters do no I/O (no db/).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const SRC = resolve(import.meta.dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** File (relative to src) to the files it imports (relative to src); packages are left out. */
function importGraph(): Map<string, string[]> {
  return new Map(sourceFiles(SRC).map((f) => {
    const specs = [...readFileSync(f, 'utf8').matchAll(/(?:from\s+|import\()['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]!);
    return [relative(SRC, f), specs.map((s) => relative(SRC, resolve(dirname(f), s)))];
  }));
}

const RULES: { from: RegExp; banned: RegExp; why: string }[] = [
  { from: /^db\//, banned: /^(semantics|control|rum|cli|api|jobs)\/|^server\.ts$/, why: 'db/ is the bottom layer' },
  { from: /^semantics\//, banned: /^(control|rum|cli|api|jobs)\/|^server\.ts$/, why: 'semantics/ does not call upwards' },
  { from: /^semantics\/(trajectory|adapters)\//, banned: /^db\//, why: 'the normaliser and adapters do no I/O' },
  { from: /^api\//, banned: /^(cli|jobs)\/|^server\.ts$/, why: 'api/ is wired by server.ts, not the other way round' },
];

export function violations(graph: Map<string, string[]>): string[] {
  return [...graph].flatMap(([file, deps]) => RULES.flatMap((r) => (r.from.test(file)
    ? deps.filter((d) => r.banned.test(d)).map((d) => `${file} imports ${d}: ${r.why}`) : [])));
}

test('the rules catch an upward import', () => {
  const g = new Map([['db/doris.ts', ['semantics/search/build.ts']], ['semantics/trajectory/normalise.ts', ['db/doris.ts']], ['rum/http.ts', ['db/doris.ts']], ['api/agents/routes.ts', ['server.ts']]]);
  assert.deepEqual(violations(g), [
    'db/doris.ts imports semantics/search/build.ts: db/ is the bottom layer',
    'semantics/trajectory/normalise.ts imports db/doris.ts: the normaliser and adapters do no I/O',
    'api/agents/routes.ts imports server.ts: api/ is wired by server.ts, not the other way round',
  ]);
});

test('the server tree keeps the layers', () => {
  assert.deepEqual(violations(importGraph()), []);
});
