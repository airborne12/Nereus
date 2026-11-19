import type { CSSProperties } from 'react';
import type { Match, MatchStep } from '../../api/sequences.ts';
import { stamp, timeOf } from '../../lib/agents/format.ts';
import { type Step, stepLabel } from '../../lib/agents/sequences.ts';

interface Props {
  pattern: Step[];
  rows: Match[];
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (column: string) => void;
  onOpen: (match: Match) => void;
  /** Matches not read yet. */
  more: number;
  onMore: () => void;
  loadingMore: boolean;
  empty: string;
}

/** One event of a match in its cell: the step it belongs to, what it is, and its target or text. */
function Cell({ step }: { step: MatchStep }) {
  return (
    <>
      <span className="ag-sn">{step.step}</span><code className={step.kind === 'call' ? '' : 'ev'}>{step.what}</code>{' '}
      <span className="ag-clip narrow" title={step.target}>{step.target}</span>{step.status === 'error' && <> <span className="ag-pill bad">failed</span></>}
    </>
  );
}

/** The places where the steps of a pattern follow one another: one row per match, one column per step. */
export function MatchTable({ pattern, rows, sort, dir, onSort, onOpen, more, onMore, loadingMore, empty }: Props) {
  const heads: { name: string; label: string; num?: boolean; title?: string }[] = [
    { name: 'time', label: 'Time' }, { name: 'session', label: 'Session' }, { name: 'agent', label: 'Agent' }, { name: 'turn', label: 'Turn', num: true },
    ...pattern.map((s, j) => ({ name: `step${j + 1}`, label: `${j + 1} · ${stepLabel(s)}` })),
    { name: 'span', label: 'Span', num: true, title: 'Events from the first step of the match to the last' },
  ];
  return (
    // The more steps a pattern has, the less room the target of each one gets.
    <table className="ag-table ag-matches" aria-label="Matches" style={{ '--k': pattern.length } as CSSProperties}>
      <thead>
        <tr>
          {heads.map((h) => {
            const sorted = sort === h.name;
            return (
              <th key={h.name} className={h.num ? 'num' : ''} title={h.title} aria-sort={sorted ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => onSort(h.name)}>{h.label}{sorted && <span className="ag-dir">{dir === 'asc' ? '↑' : '↓'}</span>}</button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => {
          const ms = timeOf(m.ts);
          const name = m.title || m.root_id;
          return (
            <tr key={`${m.session_id}:${m.steps[0]?.seq}`} tabIndex={0} onClick={() => onOpen(m)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(m); }}>
              <td>{ms !== null && <span className="ag-time">{stamp(ms)}</span>}</td>
              <td><span className="ag-clip" title={name}>{name}</span></td>
              <td>{m.agent}</td>
              <td className="num">{m.turn}</td>
              {m.steps.map((s, j) => <td key={j}><Cell step={s} /></td>)}
              <td className="num">{m.span}</td>
            </tr>
          );
        })}
        {rows.length === 0 && <tr className="ag-none"><td colSpan={heads.length}>{empty}</td></tr>}
        {more > 0 && (
          <tr className="ag-more">
            <td colSpan={heads.length}>
              <button type="button" disabled={loadingMore} onClick={onMore}>{loadingMore ? 'Loading…' : `Show ${Math.min(100, more)} more of ${more.toLocaleString('en-US')}`}</button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
