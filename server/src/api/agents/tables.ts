// The Sessions, Steps and Messages pages (spec 7, 8.2): one page of rows with the total, and their
// exports: every matching row as CSV, or the sessions as conversations in JSON lines.
//
//   GET /api/agents/sessions|steps|messages?from=&to=&q=&f=col:op:value&sort=&dir=&limit=&offset=
//   GET /api/agents/sessions|steps|messages?...&format=csv
//   GET /api/agents/sessions|steps|messages?...&format=csv&size=1   rows, bytes, a preview and the SQL, for the export dialog
//   GET /api/agents/sessions?...&format=jsonl            conversations
//   GET /api/agents/sessions?...&format=jsonl&size=1     size, a preview and the SQL, for the export dialog

import type { ServerResponse } from 'node:http';
import type { Doris } from '../../db/doris.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import {
  conversationSql, conversations, exportName, MAX_EXPORT_BYTES, MAX_EXPORT_ROWS, PREVIEW_MESSAGES, PREVIEW_ROWS, toCsv,
} from '../../semantics/trajectory/export.ts';
import { messagesPage, sessionsPage, stepsPage } from '../../semantics/trajectory/pages.ts';
import { type Page, type TableRequest, tableSql } from '../../semantics/trajectory/query.ts';
import { run, type Send, sendFile, tableRequest } from './request.ts';

const PAGES: Record<string, (db: string) => Page> = { sessions: sessionsPage, steps: stepsPage, messages: messagesPage };

async function list(doris: Doris, send: Send, res: ServerResponse, page: Page, req: TableRequest): Promise<void> {
  const { rows, total } = tableSql(page, req, 'list');
  const { results, elapsedMs } = await run(doris, [rows, total]);
  send(res, 200, {
    rows: results[0], total: Number(results[1]![0]?.total ?? 0),
    columns: page.columns.map((c) => ({ name: c.name, kind: c.kind })), sql: [rows, total], elapsedMs,
  });
}

function rowCap(n: number): string {
  return `${n} rows match; an export holds at most ${MAX_EXPORT_ROWS}. Narrow the range or the filter.`;
}

async function csv(doris: Doris, send: Send, res: ServerResponse, page: Page, req: TableRequest, sizeOnly: boolean): Promise<void> {
  const { rows, total } = tableSql(page, req, 'export', MAX_EXPORT_ROWS);
  const names = page.columns.map((c) => c.name);
  const text = new Set(page.columns.filter((c) => c.kind === 'text').map((c) => c.name));
  if (sizeOnly) {
    const peek = tableSql(page, { ...req, limit: PREVIEW_ROWS, offset: 0 }, 'list').rows;
    const { results: [sized, first], elapsedMs } = await run(doris, [total, peek]);
    send(res, 200, {
      size: { rows: Number(sized![0]?.total ?? 0), bytes: Number(sized![0]?.bytes ?? 0) }, preview: toCsv(names, first!, text), sql: [rows, total], elapsedMs,
    });
    return;
  }
  const { results: [counted] } = await run(doris, [total]);
  const n = Number(counted![0]?.total ?? 0);
  if (n > MAX_EXPORT_ROWS) throw new CompileError(rowCap(n));
  if (Number(counted![0]?.bytes ?? 0) > MAX_EXPORT_BYTES) throw new CompileError(`the export would hold more than ${MAX_EXPORT_BYTES} bytes of text. Narrow the range or the filter.`);
  const { results: [all] } = await run(doris, [rows]);
  // Rows ingested after the count must not silently cut the file.
  if (all!.length > MAX_EXPORT_ROWS) throw new CompileError(rowCap(all!.length));
  sendFile(res, exportName(page.name, 'csv'), 'text/csv', toCsv(names, all!, text));
}

async function jsonl(doris: Doris, send: Send, res: ServerResponse, db: string, req: TableRequest, sizeOnly: boolean): Promise<void> {
  const whole = conversationSql(db, req, false);
  const { results: [sized], elapsedMs } = await run(doris, [whole.size]);
  const size = sized![0];
  if (sizeOnly) {
    const peek = conversationSql(db, req, true);
    const { results: [parts, blocks], elapsedMs: more } = await run(doris, [peek.parts, peek.blocks]);
    send(res, 200, {
      size, preview: conversations(parts!, blocks!, PREVIEW_MESSAGES), sql: [whole.size, whole.parts, whole.blocks], elapsedMs: elapsedMs + more,
    });
    return;
  }
  if (Number(size?.bytes ?? 0) > MAX_EXPORT_BYTES) throw new CompileError(`the export would hold more than ${MAX_EXPORT_BYTES} bytes of text. Narrow the range or the filter.`);
  const { results: [parts, blocks] } = await run(doris, [whole.parts, whole.blocks]);
  const lines = conversations(parts!, blocks!).map((l) => JSON.stringify(l));
  sendFile(res, exportName('conversations', 'jsonl'), 'application/x-ndjson', lines.length ? `${lines.join('\n')}\n` : '');
}

/** Answers a table page or its export; false when the path is not one. */
export async function tables(doris: Doris, db: string, send: Send, res: ServerResponse, url: URL): Promise<boolean> {
  const m = /^\/api\/agents\/(sessions|steps|messages)$/.exec(url.pathname);
  if (!m) return false;
  const page = PAGES[m[1]!]!(db);
  const req = tableRequest(url);
  const format = url.searchParams.get('format');
  const sizeOnly = url.searchParams.get('size') === '1';
  if (format === null) await list(doris, send, res, page, req);
  else if (format === 'csv') await csv(doris, send, res, page, req, sizeOnly);
  else if (format === 'jsonl' && page.name === 'sessions') await jsonl(doris, send, res, db, req, sizeOnly);
  else throw new CompileError(`format must be csv${page.name === 'sessions' ? ' or jsonl' : ''}`);
  return true;
}
