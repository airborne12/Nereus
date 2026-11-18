import type { ReactNode } from 'react';
import type { Row } from '../../api/agents.ts';
import { duration, num, stamp, text, timeOf, tokens } from '../../lib/agents/format.ts';
import { type ColumnDef, columnOf, isNumeric, type PageDef, sessionName } from '../../lib/agents/pages.ts';

/** Sessions that can be ticked for a comparison. */
export const PAIR = 2;
/** Characters of a long text kept in a cell; the row opens the rest. */
const CELL_CHARS = 300;

const zero = <span className="ag-zero">0</span>;
const dash = <span className="ag-zero">-</span>;

function clip(value: string, className = 'ag-clip'): ReactNode {
  if (!value) return null;
  const short = value.length > CELL_CHARS ? `${value.slice(0, CELL_CHARS)}…` : value;
  return <span className={className} title={short}>{short}</span>;
}

/** One cell: the value written for its kind, with the few columns that carry a signal drawn as one. */
function cell(def: PageDef, c: ColumnDef, row: Row): ReactNode {
  const v = row[c.name];
  if (def.name === 'sessions' && c.name === 'title') return <b title={`session_id ${text(row.session_id)}`}>{clip(sessionName(row))}</b>;
  if (c.name === 'title') return clip(text(v) || text(row.root_id ?? row.session_id));
  if (c.name === 'tool_errors') return num(v) ? <span className="ag-pill bad">{num(v)}</span> : zero;
  if (c.name === 'status') return v === 'failed' ? <span className="ag-pill bad">failed</span> : text(v);
  if (c.name === 'repeated_call') return v ? <span className="ag-pill warn" title={`The same call was made before; its result was ${text(v)}`}>{text(v)}</span> : null;
  if (c.name === 'msg_role') return <span className="ag-role">{text(v)}</span>;
  if (c.name === 'calls') return clip(text(v), 'ag-clip mono');
  // A model call that wrote no text has a tool call as its first block; that is not its output.
  if (c.name === 'output') return row.output_kind === 'text' ? clip(text(v)) : null;
  if (c.fill) return text(v).slice(0, CELL_CHARS);
  if (v === null || v === undefined) return c.kind === 'count' ? zero : isNumeric(c.kind) ? dash : null;
  if (c.kind === 'time') {
    const ms = timeOf(v);
    return ms === null ? null : <span className="ag-time">{stamp(ms)}</span>;
  }
  if (c.kind === 'count') return num(v) ? num(v) : zero;
  if (c.name === 'ctx_tokens' || c.name === 'peak_ctx_tokens') return `${tokens(num(v))} tok`;
  if (c.kind === 'tokens') return tokens(num(v));
  if (c.kind === 'duration') return duration(num(v));
  if (c.kind === 'percent') return `${num(v)}%`;
  if (c.kind === 'number') return num(v);
  return clip(text(v));
}

const rowKey = (def: PageDef, row: Row): string =>
  `${text(row.session_id)}:${text(def.name === 'steps' ? row.seq : def.name === 'messages' ? row.msg_seq : '')}`;

interface Props {
  def: PageDef;
  /** Names of the columns shown, in the page's order. */
  columns: string[];
  rows: Row[];
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (column: string) => void;
  onOpen: (row: Row) => void;
  /** Rows that match and are not read yet. */
  more: number;
  onMore: () => void;
  loadingMore: boolean;
  /** What stands in place of rows when nothing matches. */
  empty: ReactNode;
  /** Sessions only: the ticked session ids; with two ticked, the other boxes are off. */
  picked?: string[];
  onPick?: (id: string) => void;
  onClearPicked?: () => void;
}

/** A data table in the convention of observability products: sticky sortable header, one row per record. */
export function DataTable({ def, columns, rows, sort, dir, onSort, onOpen, more, onMore, loadingMore, empty, picked, onPick, onClearPicked }: Props) {
  const cols = columns.map((name) => columnOf(def, name)).filter((c): c is ColumnDef => c !== undefined);
  const width = cols.length + (picked ? 1 : 0);
  return (
    <table className="ag-table" aria-label={def.label}>
      <thead>
        <tr>
          {picked && (
            <th className="ag-pick">
              {picked.length > 0 && (
                <input type="checkbox" checked={false} ref={(el) => { if (el) el.indeterminate = true; }} onChange={onClearPicked}
                  aria-label="Clear the ticked sessions" title="Clear the ticked sessions" />
              )}
            </th>
          )}
          {cols.map((c) => {
            const sorted = sort === c.name;
            return (
              <th key={c.name} className={isNumeric(c.kind) ? 'num' : c.fill ? 'ag-fill' : ''} aria-sort={sorted ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => onSort(c.name)}>{c.label}{sorted && <span className="ag-dir">{dir === 'asc' ? '↑' : '↓'}</span>}</button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const id = text(row.session_id);
          const ticked = picked?.includes(id) ?? false;
          return (
            <tr key={rowKey(def, row)} tabIndex={0} onClick={() => onOpen(row)}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(row); }}>
              {picked && (
                <td className="ag-pick" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={ticked} disabled={!ticked && picked.length >= PAIR} onChange={() => onPick?.(id)}
                    aria-label="Tick this session to compare it" />
                </td>
              )}
              {cols.map((c) => <td key={c.name} className={isNumeric(c.kind) ? 'num' : c.fill ? 'ag-fill' : ''}>{cell(def, c, row)}</td>)}
            </tr>
          );
        })}
        {rows.length === 0 && <tr className="ag-none"><td colSpan={width}>{empty}</td></tr>}
        {more > 0 && (
          <tr className="ag-more">
            <td colSpan={width}>
              <button type="button" disabled={loadingMore} onClick={onMore}>
                {loadingMore ? 'Loading…' : `Show ${Math.min(100, more)} more of ${more.toLocaleString('en-US')}`}
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
