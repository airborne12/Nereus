// Adds the rows of the given sessions (from DORIS_DB.otel_sessions) to demo/demo-data.json as
// `sessions`, for the offline demo. Session ids as arguments (record-sessions.ts prints them).
//
//   DORIS_PORT=9930 DORIS_DB=otel_bench node demo/export-sessions.ts <id> [<id> ...]

import { readFileSync, writeFileSync } from 'node:fs';
import { Doris, configFromEnv } from '../../server/src/db.ts';

const ids = process.argv.slice(2);
if (ids.length === 0 || !ids.every((x) => /^[A-Za-z0-9_-]{8,64}$/.test(x))) throw new Error('give session ids');
const doris = new Doris(configFromEnv());
const rows = await doris.query(`SELECT session_id, timestamp, seq, part, kind, event_type, service_name, url, user_id, user_email, user_name,
  user_agent, message, cast(attributes AS STRING) AS attributes, payload FROM ${process.env.DORIS_DB ?? 'otel_bench'}.otel_sessions
  WHERE session_id IN (${ids.map((x) => `'${x}'`).join(', ')}) ORDER BY session_id, timestamp, seq, part`);
await doris.close();
const file = new URL('demo-data.json', import.meta.url);
const snap = JSON.parse(readFileSync(file, 'utf8'));
snap.sessions = rows;
writeFileSync(file, JSON.stringify(snap));
console.log(`${rows.length} session rows, ${(JSON.stringify(rows).length / 1e6).toFixed(2)} MB`);
