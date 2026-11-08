// DORIS_TEST=1 DORIS_BE_HTTP_URL=http://127.0.0.1:8040 enables real Stream Load checks.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { Doris, configFromEnv } from '../src/db.ts';
import { migrateComplexTable } from '../../schema/upgrades/002_complex_attributes.ts';

const enabled = process.env.DORIS_TEST === '1';
const db = `nereus_schema_${randomUUID().replaceAll('-', '')}`;
let doris: Doris;
const attrs = { text: 'line one\nline two\tindent\rreturn\u0000end', path: 'C:\\logs\\new.log', quote: 'say "hello"', unicode: '\u4e2d\u6587 \u{1f600}' };
const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '');

before(async () => {
  if (!enabled) return;
  doris = new Doris(configFromEnv());
  const schema = readFileSync(new URL('../../schema/001_otel_tables.sql', import.meta.url), 'utf8')
    .replaceAll('${DB}', db).replaceAll('${RETENTION_DAYS}', '30').replaceAll('${REPLICATION_NUM}', '1').replace(/^--.*$/gm, '');
  for (const sql of schema.split(';').map((s) => s.trim()).filter(Boolean)) await doris.query(sql);
});
after(async () => {
  if (!doris) return;
  try { await doris.query(`DROP DATABASE IF EXISTS ${db}`); } finally { await doris.close(); }
});

async function load(table: string, row: Record<string, unknown>) {
  const cfg = configFromEnv();
  const response = await fetch(`${process.env.DORIS_BE_HTTP_URL ?? 'http://127.0.0.1:8040'}/api/${db}/${table}/_stream_load`, {
    method: 'PUT', headers: { authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
      format: 'json', read_json_by_line: 'true', strict_mode: 'true', max_filter_ratio: '0' }, body: `${JSON.stringify(row)}\n`,
  });
  const result = await response.json() as { Status: string };
  assert.equal(result.Status, 'Success', JSON.stringify(result));
}

test('Stream Load preserves event, link and exemplar strings as valid JSON', { skip: !enabled }, async () => {
  const event = { timestamp, name: 'event\n"quoted"', attributes: attrs };
  const link = { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), trace_state: 'state', attributes: attrs };
  await load('otel_traces', { service_name: 'schema-fidelity', timestamp, trace_id: 'c'.repeat(32), span_id: 'd'.repeat(16), events: [event], links: [link] });
  const [trace] = await doris.query(`SELECT events, links FROM ${db}.otel_traces`);
  assert.deepEqual(JSON.parse(String(trace!.events)), [event]);
  assert.deepEqual(JSON.parse(String(trace!.links)), [link]);
  const exemplar = { filtered_attributes: attrs, timestamp, value: 7, trace_id: link.trace_id, span_id: link.span_id };
  for (const kind of ['gauge', 'sum', 'histogram', 'exponential_histogram']) {
    const table = `otel_metrics_${kind}`;
    await load(table, { service_name: 'schema-fidelity', timestamp, metric_name: 'fidelity', exemplars: [exemplar] });
    const [row] = await doris.query(`SELECT exemplars FROM ${db}.${table}`);
    assert.deepEqual(JSON.parse(String(row!.exemplars)), [exemplar], table);
  }
});

test('upgrade preserves old rows and properties, keeps a backup, and accepts new escaped strings', { skip: !enabled }, async () => {
  await doris.query(`CREATE TABLE ${db}.legacy (id INT, events ARRAY<STRUCT<name:STRING,attributes:MAP<STRING,STRING>>>, attributes VARIANT)
    DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 1 PROPERTIES("replication_num"="1")`);
  await load('legacy', { id: 1, events: [{ name: 'old', attributes: { plain: 'preserved', path: attrs.path } }], attributes: { nested: { value: attrs.path } } });
  await load('legacy', { id: 2, events: null });
  const backup = await migrateComplexTable(doris, db, 'legacy', ['events']);
  assert.equal(backup, `${db}.legacy_before_complex_variant`);
  const old = await doris.query(`SELECT id, to_json(events) AS events FROM ${backup} ORDER BY id`);
  const next = await doris.query(`SELECT id, events FROM ${db}.legacy ORDER BY id`);
  const parsed = (rows: Record<string, unknown>[]) => rows.map((r) => ({ id: r.id, events: r.events === null ? null : JSON.parse(String(r.events)) }));
  assert.deepEqual(parsed(next), parsed(old));
  const [attributes] = await doris.query(`SELECT attributes FROM ${db}.legacy WHERE id=1`);
  assert.deepEqual(JSON.parse(String(attributes!.attributes)), { nested: { value: attrs.path } });
  assert.equal(await migrateComplexTable(doris, db, 'legacy', ['events']), null);
  const [ddl] = await doris.query(`SHOW CREATE TABLE ${db}.legacy`);
  assert.match(String(ddl!['Create Table']), /DUPLICATE KEY\(`id`\)/);
  await load('legacy', { id: 3, events: [{ name: 'new', attributes: attrs }] });
  const [row] = await doris.query(`SELECT events FROM ${db}.legacy WHERE id=3`);
  assert.deepEqual(JSON.parse(String(row!.events)), [{ name: 'new', attributes: attrs }]);
});
