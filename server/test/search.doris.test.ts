// Runs compiled queries on a live Doris loaded by bench/otelgen.py and compares each row count
// with a hand-written reference SQL. Skipped unless DORIS_TEST=1.
//
//   DORIS_TEST=1 DORIS_PORT=9730 DORIS_DB=otel_bench node --test test/search.doris.test.ts

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { compileWhere } from '../src/query/compile.ts';
import { logsSource, tracesSource } from '../src/query/source.ts';

const enabled = process.env.DORIS_TEST === '1';
const host = process.env.DORIS_HOST ?? '127.0.0.1';
const port = process.env.DORIS_PORT ?? '9030';
const db = process.env.DORIS_DB ?? 'otel_bench';

function scalar(sql: string): string {
  const out = execFileSync('mysql', ['-h', host, '-P', port, '-uroot', '-N', '-B', '-e',
    `SET inverted_index_skip_threshold = 0; ${sql}`], { encoding: 'utf8' });
  return out.trim();
}

const logs = logsSource(db);
const traces = tracesSource(db);

// [search bar query, reference WHERE clause]
const logCases: [string, string][] = [
  ['level:ERROR "timeout after"', "severity_text = 'ERROR' AND body MATCH_PHRASE 'timeout after'"],
  ['resource_attributes.k8s.pod.name:payment-2', "CAST(resource_attributes['k8s.pod.name'] AS STRING) = 'payment-2'"],
  ['k8s.pod.name:cart-1', "CAST(resource_attributes['k8s.pod.name'] AS STRING) = 'cart-1'"],
  ['NOT k8s.pod.name:cart-1', "NOT coalesce(CAST(resource_attributes['k8s.pod.name'] AS STRING) = 'cart-1', false)"],
  ['-service:frontend level:(WARN OR ERROR)', "service_name <> 'frontend' AND severity_text IN ('WARN', 'ERROR')"],
  ['redis*', "lower(body) REGEXP '(^|[^a-z0-9])redis[a-z0-9]*'"],
  ['body:/time.*/', "lower(body) REGEXP '(^|[^a-z0-9])time[a-z0-9]*'"],
  ['log_attributes.thread.id:7', "CAST(log_attributes['thread.id'] AS INT) = 7"],
  ['thread.id:[1 TO 10]', "CAST(log_attributes['thread.id'] AS INT) BETWEEN 1 AND 10"],
  ['scope_name:ca*', "scope_name LIKE 'ca%'"],
  ['severity_number:>=13 service:checkout', "severity_number >= 13 AND service_name = 'checkout'"],
  ['upstream timeout', "body MATCH_ALL 'upstream timeout'"],
  ['declined OR refused', "body MATCH_ANY 'declined refused'"],
];

const traceCases: [string, string][] = [
  ['duration:[10000 TO 20000]', 'duration BETWEEN 10000 AND 20000'],
  ['span_attributes.http.status_code:>=500', "CAST(span_attributes['http.status_code'] AS INT) >= 500"],
  ['service:frontend kind:SPAN_KIND_SERVER status:STATUS_CODE_ERROR',
    "service_name = 'frontend' AND span_kind = 'SPAN_KIND_SERVER' AND status_code = 'STATUS_CODE_ERROR'"],
  ['name:"GET /checkout"', "span_name = 'GET /checkout'"],
  ['name:GET*', "span_name LIKE 'GET%'"],
  ['service:frontend duration:>50000', "service_name = 'frontend' AND duration > 50000"],
  ['is_root:1 -status:STATUS_CODE_UNSET', "is_root = 1 AND status_code <> 'STATUS_CODE_UNSET'"],
];

for (const [source, cases] of [[logs, logCases], [traces, traceCases]] as const) {
  for (const [query, reference] of cases) {
    test(`${source.name}: ${query}`, { skip: !enabled }, () => {
      const where = compileWhere(source, query);
      const got = scalar(`SELECT count(*) FROM ${source.table} WHERE ${where}`);
      const want = scalar(`SELECT count(*) FROM ${source.table} WHERE ${reference}`);
      assert.equal(got, want, `compiled: ${where}`);
      assert.notEqual(want, '0', 'reference matches nothing; the case proves nothing');
    });
  }
}

// Hostile input must still be one well-formed predicate: it runs and matches nothing.
const hostile = [
  `body:"x') OR 1=1 --"`,
  `scope_name:"x') OR 1=1 --"`,
  `"quote \\" and back\\\\slash"`,
  `service:a\\'b`,
  `body:/a\\/b'c/`,
  `scope_name:100%_done*`,
  `k8s.pod.name:"); DROP TABLE x; --"`,
];
for (const query of hostile) {
  test(`hostile input stays a literal: ${query}`, { skip: !enabled }, () => {
    const where = compileWhere(logs, query);
    assert.equal(scalar(`SELECT count(*) FROM ${logs.table} WHERE ${where}`), '0', `compiled: ${where}`);
  });
}
