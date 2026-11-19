// One memory (spec 7, 8.8): its latest version with its fields and sections, its versions, the calls
// that read or wrote it, the states the validity fold gave its latest version, and its state.
//
//   GET /api/agents/memories/<agent>/<scope>/<name>     each part encoded as a URI component

import type { ServerResponse } from 'node:http';
import type { Doris } from '../../db/doris.ts';
import { type MemoryRef, memorySql, memoryState } from '../../semantics/memories/pages.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import { run, type Send } from './request.ts';

const ADDRESS = /^\/api\/agents\/memories\/([^/]+)\/([^/]+)\/([^/]+)$/;

function refOf(m: RegExpExecArray): MemoryRef {
  try {
    return { agent: decodeURIComponent(m[1]!), scope: decodeURIComponent(m[2]!), name: decodeURIComponent(m[3]!) };
  } catch {
    throw new CompileError('not a memory address: its agent, scope and name must each be encoded as a URI component');
  }
}

/** A JSON column as Doris returns it, read back; text that is not JSON stays as it is. */
function json(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export async function memory(doris: Doris, db: string, send: Send, res: ServerResponse, url: URL): Promise<boolean> {
  const m = ADDRESS.exec(url.pathname);
  if (!m) return false;
  const ref = refOf(m);
  const s = memorySql(db, ref);
  const { results: [versions, uses, history], elapsedMs } = await run(doris, [s.versions, s.uses, s.history]);
  const latest = versions![0];
  if (!latest) {
    send(res, 404, { error: 'no such memory' });
    return true;
  }
  send(res, 200, {
    memory: { ...ref, ...latest, sections: json(latest.sections) ?? [], fields: json(latest.fields) ?? {} },
    versions: versions!.map(({ content: _c, sections: _s, fields: _f, ...rest }) => rest),
    uses, history, state: memoryState(latest, uses!, history!), sql: [s.versions, s.uses, s.history], elapsedMs,
  });
  return true;
}
