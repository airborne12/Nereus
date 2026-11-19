// What the export dialog says about a file before it is read: its formats, its size in words and a preview.

import type { ExportFormat, ExportSize, TableName } from '../../api/agents.ts';
import { fileSize, num, plural } from './format.ts';

export interface FormatDef { id: ExportFormat; name: string; type: string; about: string }

const TABLE: FormatDef = { id: 'csv', name: 'Table', type: '.csv', about: 'One row per record, every column under its database name.' };
const CONVERSATIONS: FormatDef = {
  id: 'jsonl', name: 'Conversations', type: '.jsonl',
  about: 'One line per session and sub-agent session between two compactions: the messages with their roles, as the model had them.',
};

/** The formats a page exports: every page as a table, the Sessions page also as conversations. */
export const formatsOf = (page: TableName): FormatDef[] => (page === 'sessions' ? [TABLE, CONVERSATIONS] : [TABLE]);

/** How many records an export holds, by what the size answer counts. */
export function recordsOf(format: ExportFormat, size: ExportSize['size']): number {
  return num(format === 'csv' ? size.rows : size.parts);
}

/** The size of an export in words. */
export function countsText(format: ExportFormat, size: ExportSize['size']): string {
  if (format === 'csv') return plural(num(size.rows), 'row');
  return `${plural(num(size.parts), 'line')} at most · ${plural(num(size.blocks), 'message block')} · ${fileSize(num(size.bytes))}`;
}

/** Longest text a preview line shows of one value. */
const PREVIEW_CHARS = 160;

/** The preview of an export as text: CSV as it is, conversations one JSON line each with long values cut. */
export function previewText(preview: ExportSize['preview']): string {
  if (typeof preview === 'string') return preview;
  const cut = (_key: string, v: unknown) => (typeof v === 'string' && v.length > PREVIEW_CHARS ? `${v.slice(0, PREVIEW_CHARS)}…` : v);
  return preview.map((line) => JSON.stringify(line, cut)).join('\n');
}
