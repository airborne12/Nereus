// Browser session ingestion: validate what the SDK sends and turn it into otel_sessions rows.
//
// Body: {sessionId, service?, userAgent?, user?: {id, email, name},
//        replay?: [{seq, t, events: [...rrweb events]}],
//        events?: [{t, type, url?, message?, attributes?}]}
// t is epoch milliseconds. Anything that does not fit is rejected with 400 rather than trimmed,
// except free text, which is cut to its column's size.

import { escape } from 'mysql2';

export class IngestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (m: string): never => {
  throw new IngestError(400, m);
};

export const EVENT_TYPES = ['click', 'navigation', 'error', 'console', 'network', 'custom'] as const;
export const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_EVENTS = 1000;
const MAX_CHUNKS = 50;
const MAX_ATTRIBUTES = 16_384;
/** Code units per payload part: 3 bytes each at most in UTF-8, under Doris' 1 MB STRING default. */
export const PART_CHARS = 200_000;
/** Events must be within a day of the server clock, so a wrong client clock cannot scatter data. */
const SKEW_MS = 86_400_000;

export interface SessionRow {
  session_id: string;
  timestamp: string;
  seq: number;
  part: number;
  kind: 'replay' | 'event';
  event_type: string;
  service_name: string;
  url: string | null;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  user_agent: string | null;
  message: string | null;
  attributes: string | null;
  payload: string | null;
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? null : bad('text fields must be strings'));

function time(v: unknown, now: number): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad('t must be epoch milliseconds');
  if (Math.abs((v as number) - now) > SKEW_MS) bad('t is more than a day away from the server clock');
  // Doris DATETIME(6) text in UTC.
  return new Date(v as number).toISOString().replace('T', ' ').replace('Z', '');
}

/** Split a string into parts of at most `size` code units without cutting a surrogate pair. */
export function splitParts(s: string, size = PART_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + size);
    const last = s.charCodeAt(end - 1);
    if (end < s.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(s.slice(i, end));
    i = end;
  }
  return out.length ? out : [''];
}

export function sessionRows(body: Record<string, unknown>, now: number): SessionRow[] {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) bad('sessionId must be 8-64 letters, digits, _ or -');
  const user = (body.user ?? {}) as Record<string, unknown>;
  if (typeof user !== 'object' || Array.isArray(user)) bad('user must be an object');
  const common = {
    session_id: sessionId as string,
    service_name: text(body.service, 256) ?? '',
    user_id: text(user.id, 256), user_email: text(user.email, 320), user_name: text(user.name, 256),
    user_agent: text(body.userAgent, 1000),
  };
  const replay = body.replay ?? [];
  const events = body.events ?? [];
  if (!Array.isArray(replay) || replay.length > MAX_CHUNKS) bad(`replay must be a list of at most ${MAX_CHUNKS} chunks`);
  if (!Array.isArray(events) || events.length > MAX_EVENTS) bad(`events must be a list of at most ${MAX_EVENTS} events`);
  const rows: SessionRow[] = [];
  for (const c of replay as Record<string, unknown>[]) {
    if (!Number.isSafeInteger(c?.seq) || (c.seq as number) < 0) bad('a replay chunk needs a seq (0 or more)');
    if (!Array.isArray(c.events) || c.events.length === 0) bad('a replay chunk needs rrweb events');
    const ts = time(c.t, now);
    splitParts(JSON.stringify(c.events)).forEach((payload, part) => rows.push({
      ...common, timestamp: ts, seq: c.seq as number, part, kind: 'replay', event_type: '', url: null, message: null, attributes: null, payload,
    }));
  }
  for (const e of events as Record<string, unknown>[]) {
    if (!(EVENT_TYPES as readonly string[]).includes(e?.type as string)) bad(`event type must be one of ${EVENT_TYPES.join(', ')}`);
    let attributes: string | null = null;
    if (e.attributes !== undefined && e.attributes !== null) {
      if (typeof e.attributes !== 'object' || Array.isArray(e.attributes)) bad('event attributes must be an object');
      attributes = JSON.stringify(e.attributes);
      if (attributes.length > MAX_ATTRIBUTES) bad('event attributes are too large');
    }
    rows.push({
      ...common, timestamp: time(e.t, now), seq: 0, part: 0, kind: 'event', event_type: e.type as string,
      url: text(e.url, 2000), message: text(e.message, 2000), attributes, payload: null,
    });
  }
  return rows;
}

const COLUMNS: (keyof SessionRow)[] = ['session_id', 'timestamp', 'seq', 'part', 'kind', 'event_type', 'service_name', 'url',
  'user_id', 'user_email', 'user_name', 'user_agent', 'message', 'attributes', 'payload'];

/** INSERT statements of at most about `maxBytes` of values each. */
export function insertSql(table: string, rows: SessionRow[], maxBytes = 4_000_000): string[] {
  const out: string[] = [];
  let batch: string[] = [];
  let size = 0;
  const flush = () => {
    if (batch.length) out.push(`INSERT INTO ${table} (${COLUMNS.join(', ')}) VALUES ${batch.join(', ')}`);
    batch = [];
    size = 0;
  };
  for (const r of rows) {
    // A JSON text inserted into a VARIANT stays a string scalar; through JSON it becomes an object
    // whose paths (attributes['status']) can be queried.
    const v = `(${COLUMNS.map((c) => (c === 'attributes' && r[c] !== null ? `CAST(CAST(${escape(r[c])} AS JSON) AS VARIANT)` : escape(r[c]))).join(', ')})`;
    if (size + v.length > maxBytes) flush();
    batch.push(v);
    size += v.length;
  }
  flush();
  return out;
}
