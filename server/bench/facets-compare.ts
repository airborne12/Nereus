// Facets with the sample as SELECT * (before) and as the faceted expressions only (now), at scale.
//   PATH=/opt/doris/node/bin:$PATH DORIS_PORT=9930 DORIS_DB=otel_scale node bench/facets-compare.ts
import mysql from 'mysql2/promise';
import { defaultFacetFields, facetsSql, fieldsFromDescribe, searchWhere } from '../src/query/build.ts';
import { fieldExpr } from '../src/query/compile.ts';
import { logsSource, tracesSource } from '../src/query/source.ts';

const DB = process.env.DORIS_DB ?? 'otel_scale';
const conn = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.DORIS_PORT ?? 9030), user: 'root', dateStrings: true });
await conn.query('SET inverted_index_skip_threshold = 0, describe_extend_variant_column = true, enable_sql_cache = false');
const [[{ t }]] = (await conn.query(`SELECT max(timestamp) AS t FROM ${DB}.otel_logs`)) as unknown as [[{ t: string }]];
const end = Date.parse(`${t.replace(' ', 'T')}Z`) + 1000;
for (const src of [logsSource(DB), tracesSource(DB)]) {
  const fields = defaultFacetFields(src, fieldsFromDescribe(src, (await conn.query(`DESC ${src.table}`))[0] as never)).slice(0, 40);
  for (const [label, ms, where] of [['1h', 3600_000, ''], ['7d', 7 * 86400_000, ''], ['7d filtered', 7 * 86400_000, 'service:checkout']] as const) {
    const spec = { where, language: 'lucene' as const, filters: [], from: new Date(end - ms).toISOString(), to: new Date(end).toISOString() };
    const before = `SELECT count(*) AS __sampled, ${fields.map((f, i) => `topn(${fieldExpr(src, f)}, 10) AS f${i}`).join(', ')} ` +
      `FROM (SELECT * FROM ${src.table} WHERE ${searchWhere(src, spec)} ORDER BY timestamp DESC LIMIT 20000) s`;
    const now = facetsSql(src, spec, fields);
    const time = async (sql: string) => {
      const ts: number[] = [];
      let out = '';
      for (let i = 0; i < 4; i++) {
        const t0 = performance.now();
        const [r] = await conn.query(sql);
        ts.push(performance.now() - t0);
        out = JSON.stringify(r);
      }
      return { ms: Math.round(ts.slice(1).sort((a, b) => a - b)[1]!), out };
    };
    const a = await time(before), b = await time(now);
    console.log(`${src.name.padEnd(7)} ${label.padEnd(12)} SELECT *: ${String(a.ms).padStart(5)} ms   faceted only: ${String(b.ms).padStart(5)} ms   same result: ${a.out === b.out}`);
  }
}
await conn.end();
