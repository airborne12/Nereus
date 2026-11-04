import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompileError, compileWhere, sqlString } from '../src/query/compile.ts';
import { QuerySyntaxError } from '../src/query/ast.ts';
import { parseQuery } from '../src/query/parser.ts';
import { logsSource, tracesSource } from '../src/query/source.ts';

const logs = logsSource();
const traces = tracesSource();
const w = (q: string) => compileWhere(logs, q);
const wt = (q: string) => compileWhere(traces, q);

test('empty query matches everything', () => {
  assert.equal(w(''), 'TRUE');
  assert.equal(w('   '), 'TRUE');
});

test('bare words search the default field and are ANDed', () => {
  assert.equal(w('timeout'), "search('body:timeout')");
  assert.equal(w('upstream timeout'), "search('(body:upstream AND body:timeout)')");
});

test('fields, aliases and phrases', () => {
  assert.equal(w('level:ERROR'), "search('(severity_text:ERROR OR severity_text:error OR severity_text:Error)')");
  assert.equal(w('service:checkout "timeout after"'),
    `search('(service_name:checkout AND body:"timeout after")')`);
  // A keyword index holds whole values: a quoted value is one escaped term.
  assert.equal(w('service:"product catalog"'), "search('service_name:product\\\\ catalog')");
});

test('boolean operators, precedence and negation', () => {
  assert.equal(w('a OR b c'), "search('(body:a OR (body:b AND body:c))')");
  assert.equal(w('(a OR b) AND NOT c'), "search('((body:a OR body:b) AND NOT body:c)')");
  assert.equal(w('-level:DEBUG'), "search('NOT (severity_text:DEBUG OR severity_text:debug OR severity_text:Debug)')");
  assert.equal(w('service:(cart OR payment)'), "search('(service_name:cart OR service_name:payment)')");
});

test('wildcards and regexes go to search() on indexed fields', () => {
  assert.equal(w('redis*'), "search('body:redis*')");
  assert.equal(w('service:pay?ent'), "search('service_name:pay?ent')");
  assert.equal(w('body:/time.*/'), "search('body:/time.*/')");
});

test('attribute fields resolve to VARIANT paths', () => {
  assert.equal(w('resource_attributes.k8s.pod.name:payment-2'),
    "search('resource_attributes.k8s.pod.name:payment\\\\-2')");
  // Unknown dotted fields are looked up in every attribute column.
  assert.equal(w('k8s.pod.name:cart-1'),
    "search('(log_attributes.k8s.pod.name:cart\\\\-1 OR resource_attributes.k8s.pod.name:cart\\\\-1)')");
});

test('ranges and comparisons compile to SQL, never to search()', () => {
  assert.equal(wt('duration:[10000 TO 20000]'), 'duration >= 10000 AND duration <= 20000');
  assert.equal(wt('duration:{10 TO *]'), 'duration > 10');
  assert.equal(wt('duration:>=500'), 'duration >= 500');
  assert.equal(wt('span_attributes.http.status_code:[500 TO 599]'),
    "CAST(span_attributes['http.status_code'] AS DOUBLE) >= 500 AND CAST(span_attributes['http.status_code'] AS DOUBLE) <= 599");
  assert.equal(w('timestamp:>2026-11-04T05:00:00'), "timestamp > '2026-11-04 05:00:00'");
});

test('number fields compile to SQL equality and reject non-numbers', () => {
  assert.equal(w('severity_number:17'), 'severity_number = 17');
  assert.throws(() => w('severity_number:abc'), CompileError);
  assert.throws(() => w('severity_number:1*'), CompileError);
});

test('mixed search() and SQL leaves', () => {
  assert.equal(wt('service:frontend duration:>1000'),
    "(search('service_name:frontend') AND duration > 1000)");
  assert.equal(wt('NOT duration:<10'), 'NOT coalesce(duration < 10, false)');
});

test('unindexed columns compile to SQL', () => {
  assert.equal(w('scope_name:cart'), "scope_name = 'cart'");
  assert.equal(w('scope_name:ca*_x'), "scope_name LIKE 'ca%\\\\_x'");
  assert.equal(w('scope_version:/1\\..*/'), "scope_version REGEXP '1\\\\..*'");
  assert.equal(w('scope_name:*'), 'scope_name IS NOT NULL');
});

test('user text cannot break out of literals', () => {
  const evil = "x') OR 1=1 --";
  const sql = w(`scope_name:"${evil}"`);
  assert.equal(sql, `scope_name LIKE ${sqlString(`%${evil}%`)}`);
  assert.match(sql, /^scope_name LIKE '%x\\'\) OR 1=1 --%'$/);
  const dsl = w(`body:"it's \\"quoted\\" \\\\ back"`);
  assert.equal(dsl, `search('body:"it\\'s \\\\"quoted\\\\" \\\\\\\\ back"')`);
});

test('field names are validated', () => {
  assert.throws(() => w('bad;name:x'), QuerySyntaxError);
  assert.throws(() => w('a*b:x'), QuerySyntaxError);
});

test('syntax errors carry a position', () => {
  assert.throws(() => parseQuery('"unterminated'), QuerySyntaxError);
  assert.doesNotThrow(() => parseQuery('a:/no-closing-slash'));
  assert.throws(() => parseQuery('(a OR b'), QuerySyntaxError);
  assert.throws(() => parseQuery('a:[1 2]'), QuerySyntaxError);
  assert.throws(() => parseQuery('a:(b:c)'), QuerySyntaxError);
});

test('case-insensitive fields match the usual spellings, aliases map short values', () => {
  assert.equal(w('level:error'), "search('(severity_text:ERROR OR severity_text:error OR severity_text:Error)')");
  assert.equal(w('level:Error'), "search('(severity_text:ERROR OR severity_text:error OR severity_text:Error)')");
  assert.equal(w('level:warning'), "search('(severity_text:WARN OR severity_text:warn OR severity_text:Warn)')");
  assert.equal(w('level:err*'), "search('(severity_text:ERR* OR severity_text:err* OR severity_text:Err*)')");
  assert.equal(wt('status:error'), "search('(status_code:STATUS_CODE_ERROR OR status_code:status_code_error OR status_code:Status_code_error)')");
  assert.equal(wt('kind:server'), "search('(span_kind:SPAN_KIND_SERVER OR span_kind:span_kind_server OR span_kind:Span_kind_server)')");
  assert.equal(w('level:eRRor'), "search('(severity_text:ERROR OR severity_text:error OR severity_text:Error OR severity_text:eRRor)')");
  // Fields without the flag stay exact.
  assert.equal(w('service:Cart'), "search('service_name:Cart')");
});

test('durations take unit suffixes; plain numbers stay microseconds', () => {
  assert.equal(wt('duration:>50ms'), 'duration > 50000');
  assert.equal(wt('duration:[1.5s TO 2m]'), 'duration >= 1500000 AND duration <= 120000000');
  assert.equal(wt('duration:250us'), 'duration = 250');
  assert.equal(wt('duration:>500'), 'duration > 500');
  assert.throws(() => wt('duration:>fast'), /not a duration/);
  assert.throws(() => w('severity_number:>5ms'), /not a number/);
});

test('a pasted trace or span id also searches the id column', () => {
  const tid = '4BF92F3577B34DA6A3CE929D0E0E4736';
  assert.equal(wt(tid), `search('((span_name:${tid} OR service_name:${tid}) OR trace_id:${tid.toLowerCase()})')`);
  assert.equal(w('00f067aa0ba902b7'), "search('(body:00f067aa0ba902b7 OR span_id:00f067aa0ba902b7)')");
  assert.equal(w('deadbeef'), "search('body:deadbeef')");
});

test('traces: bare words search span names and services', () => {
  assert.equal(wt('checkout'), "search('(span_name:checkout OR service_name:checkout)')");
  assert.equal(wt('name:"GET /checkout"'), `search('span_name:"GET /checkout"')`);
});

test('unknown fields are reported with a likely correction', async () => {
  const { unknownFields } = await import('../src/query/compile.ts');
  const known = ['body', 'level', 'severity_text', 'service', 'service_name', 'k8s.pod.name', 'thread.id'];
  assert.deepEqual(unknownFields(logs, 'levl:ERROR timeout', known), [{ field: 'levl', suggestion: 'level' }]);
  assert.deepEqual(unknownFields(logs, 'k8s.pod.nme:x', known), [{ field: 'k8s.pod.nme', suggestion: 'k8s.pod.name' }]);
  assert.deepEqual(unknownFields(logs, 'customer.tier:gold', known), [{ field: 'customer.tier', suggestion: null }]);
  assert.deepEqual(unknownFields(logs, 'level:ERROR resource_attributes.k8s.pod.name:a scope_name:x -k8s.pod.name:b', known), []);
});

test('values that start with a slash are paths, not regexes', () => {
  assert.equal(wt('http.route:/checkout'),
    "search('(span_attributes.http.route:\\\\/checkout OR resource_attributes.http.route:\\\\/checkout)')");
  assert.equal(wt('name:/api/v1/users'), "search('span_name:\\\\/api\\\\/v1\\\\/users')");
  assert.equal(w('body:/time.*/'), "search('body:/time.*/')");
  assert.equal(w('(body:/time.*/)'), "search('body:/time.*/')");
});
