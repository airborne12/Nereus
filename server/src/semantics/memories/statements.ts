// The statements and rows of memory capture (spec 5.9, 6.5): the latest version of each memory of
// a store, a new version, and the row that says a memory is gone from its store.

import { sqlString } from '../search/compile.ts';
import type { Statement } from '../trajectory/query.ts';
import type { MemoryRecord } from './model.ts';
import type { Source } from './source.ts';

/** The content hash of the row that says a memory is gone from its store. */
export const REMOVED = 'removed';

/** The latest version of each memory of one store, an agent's memories of one scope. */
export const storeVersionsSql = (db: string, agent: string, scope: string): Statement => ({
  title: 'Memories of the store',
  sql: [
    'SELECT name, max_by(content_hash, captured_at) AS content_hash, max_by(location, captured_at) AS location, max_by(format, captured_at) AS format,',
    '       max(captured_at) AS captured_at, max_by(source_kind, captured_at) AS source_kind',
    `FROM ${db}.agent_memories`,
    `WHERE agent = ${sqlString(agent)} AND scope = ${sqlString(scope)}`,
    'GROUP BY name',
  ].join('\n'),
});

/** The row of a new version of a memory, captured at `capturedAt`, with its source. */
export function memoryRow(m: MemoryRecord, capturedAt: string, source: Source): Record<string, unknown> {
  return {
    agent: m.agent, scope: m.scope, name: m.name, captured_at: capturedAt, format: m.format, location: m.location,
    description: m.description, kind: m.kind, content: m.content, sections: m.sections, fields: m.fields,
    content_hash: m.content_hash, updated_at: m.updated_at, ...source,
  };
}

/** The row that says a memory was no longer in its store when it was captured at `capturedAt`. */
export function removedRow(v: { agent: string; scope: string; name: string; location: string | null; format: string | null }, capturedAt: string): Record<string, unknown> {
  return {
    agent: v.agent, scope: v.scope, name: v.name, captured_at: capturedAt, format: v.format, location: v.location,
    description: null, kind: null, content: null, sections: null, fields: null, content_hash: REMOVED, updated_at: capturedAt,
    source_session_id: null, source_kind: null, source_score: null,
  };
}
