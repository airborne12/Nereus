// SQL for the Sessions pages: sessions with any event matching the search, and one session's rows.

import { escape } from 'mysql2';
import { type SearchSpec, searchWhere } from '../query/build.ts';
import type { Source } from '../query/source.ts';

const lit = (ms: number) => escape(new Date(ms).toISOString().replace('T', ' ').replace('Z', ''));

/**
 * One row per session active in [from, to) that has an event matching the search. A session
 * counts from its first to its last row in the range; its user is the last one set.
 */
export function sessionsListSql(source: Source, spec: SearchSpec, limit = 200): string {
  const from = Date.parse(spec.from), to = Date.parse(spec.to);
  const t = source.table;
  const range = `timestamp >= ${lit(from)} AND timestamp < ${lit(to)}`;
  return `SELECT session_id, min(timestamp) AS started, max(timestamp) AS ended, max(service_name) AS service, ` +
    `max_by(user_email, timestamp) AS user_email, max_by(user_name, timestamp) AS user_name, max_by(user_id, timestamp) AS user_id, ` +
    // min_by skips rows whose url is NULL (replay chunks), so this is the first page of the session.
    `min_by(url, timestamp) AS first_url, ` +
    `max(user_agent) AS user_agent, ` +
    `sum(if(event_type = 'click', 1, 0)) AS clicks, sum(if(event_type = 'navigation', 1, 0)) AS pages, ` +
    // Errors as the timeline marks them: thrown errors, console errors, failed requests (>= 400 or no answer).
    `sum(if(event_type = 'error' OR (event_type = 'console' AND message LIKE 'error%') OR ` +
    `(event_type = 'network' AND (cast(attributes['status'] AS INT) >= 400 OR cast(attributes['status'] AS INT) = 0)), 1, 0)) AS errors, ` +
    `sum(if(event_type = 'network', 1, 0)) AS requests, sum(if(kind = 'replay', 1, 0)) AS replay_parts ` +
    `FROM ${t} WHERE ${range} AND session_id IN (SELECT session_id FROM ${t} WHERE ${searchWhere(source, spec)}) ` +
    `GROUP BY session_id ORDER BY started DESC LIMIT ${Math.trunc(limit)}`;
}

/** Every row of one session between from and to, in replay order. */
export function sessionRowsSql(source: Source, sessionId: string, fromMs: number, toMs: number): string {
  return `SELECT timestamp, seq, part, kind, event_type, url, message, attributes, payload, service_name, user_id, user_email, user_name, user_agent ` +
    `FROM ${source.table} WHERE session_id = ${escape(sessionId)} AND timestamp >= ${lit(fromMs)} AND timestamp < ${lit(toMs)} ` +
    `ORDER BY timestamp, seq, part LIMIT 100000`;
}

/**
 * The session whose network request carried this trace id (the SDK records the traceparent it
 * sent), with that session's first and last row so the replay can be opened at the request.
 */
export function sessionForTraceSql(source: Source, traceId: string, fromMs: number, toMs: number): string {
  const t = source.table;
  const range = (col: string) => `${col} >= ${lit(fromMs)} AND ${col} < ${lit(toMs)}`;
  return `SELECT r.session_id, r.timestamp, r.user_email, r.user_name, min(s.timestamp) AS started, max(s.timestamp) AS ended FROM ` +
    `(SELECT session_id, timestamp, user_email, user_name FROM ${t} WHERE ${range('timestamp')} AND event_type = 'network' ` +
    `AND cast(attributes['trace_id'] AS STRING) = ${escape(traceId)} ORDER BY timestamp LIMIT 1) r ` +
    `JOIN ${t} s ON s.session_id = r.session_id WHERE ${range('s.timestamp')} ` +
    `GROUP BY r.session_id, r.timestamp, r.user_email, r.user_name`;
}
