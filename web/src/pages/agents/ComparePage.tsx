import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../../api/agents.ts';
import { LaneGraph } from '../../components/agents/LaneGraph.tsx';
import { SqlDialog } from '../../components/agents/SqlDialog.tsx';
import { type Cell, delta, FACTS, PAIRS_PAGE, type PlanRow, planRows, sideLane, type SideRow, toolsLabel } from '../../lib/agents/compare.ts';
import { duration, plainLine, plural, text, tokens } from '../../lib/agents/format.ts';
import { HEIGHT, indent } from '../../lib/agents/lane-draw.ts';
import { buildTree, chain, type Tree } from '../../lib/agents/lanes.ts';
import { sessionName, sessionUrl } from '../../lib/agents/pages.ts';
import { cutKey, stepKey } from '../../lib/agents/select.ts';
import type { Go } from '../../Root.tsx';
import type { From } from './TablePage.tsx';

/** A session with at most this many steps opens with every pair of turns open. */
const OPEN_ALL_STEPS = 40;

interface Loaded { a: Tree; b: Tree; sql: api.Statement[] }

const treeOf = (answer: api.CompareAnswer, id: string): Tree =>
  buildTree({ sessions: answer.sessions.filter((s) => s.root_id === id), turns: answer.turns.filter((t) => t.session_id === id), marks: [] });

/** The words of one side of a row. A turn opens and closes on both sides at once; a step or a compaction opens in its session. */
function words(cell: NonNullable<Cell>, side: SideRow, row: PlanRow, first: boolean, onMore: () => void) {
  if (cell.type === 'more') {
    if (row.rest === 0) return <span className="ag-dim">Reading the steps…</span>;
    return first ? <button type="button" onClick={onMore}>Show {Math.min(PAIRS_PAGE, row.rest)} more of {plural(row.rest, 'row')}</button> : null;
  }
  if (cell.type === 'cut') return <><span className="ag-tl">Compaction</span><span className="ag-tm">{tokens(side.from)} → {tokens(side.to)} tokens</span></>;
  if (cell.type === 'step') {
    const s = cell.step;
    return (
      <>
        <span className="ag-tl"><span className="ag-sn">{s.step}</span>{s.tools === 'reply' ? <span className="ag-dim">Reply</span> : <><code>{toolsLabel(s.tools)}</code> {s.targets}</>}</span>
        <span className="ag-tm">{s.failed && <b className="bad">failed</b>}</span>
        <span className="ag-td" />
      </>
    );
  }
  const t = cell.turn;
  const c = chain(t.tools);
  return (
    <>
      <span className="ag-tl ag-tt">{plainLine(t.userInput).slice(0, 200) || 'No user input'}</span>
      <span className="ag-tm">{t.failedCalls > 0 && <b className="bad">{t.failedCalls} failed</b>}<span className="ag-tw">{plural(t.steps, 'step')}<i>{cell.open ? '▾' : '▸'}</i></span></span>
      <span className="ag-td">{duration(t.activeUs)}</span>
      {!cell.open && (
        <span className="ag-sub">
          <span className="ag-chain">
            {c.links.map((l, i) => <span key={i}>{i > 0 && <i>→</i>}<span className={l.bad ? 'bad' : ''}>{l.name}{l.n > 1 ? ` ×${l.n}` : ''}{l.bad ? ' failed' : ''}</span></span>)}
            {c.more && <><i>→</i>…</>}
            {c.links.length === 0 && t.steps > 0 && <span>reply</span>}
          </span>
          {t.compactions > 0 && <span className="ag-cc">{plural(t.compactions, 'compaction')}</span>}
        </span>
      )}
    </>
  );
}

/** The comparison of two sessions ticked on the Sessions page: their facts, then their lanes side by side. */
export function ComparePage({ search, go }: { search: string; go: Go }) {
  const params = new URLSearchParams(search);
  const a = params.get('a') ?? '';
  const b = params.get('b') ?? '';
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairs, setPairs] = useState<ReadonlyMap<number, api.TurnPair>>(new Map());
  const [pairSql, setPairSql] = useState<ReadonlyMap<number, api.Statement[]>>(new Map());
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [shown, setShown] = useState<ReadonlyMap<number, number>>(new Map());
  const [showSql, setShowSql] = useState(false);

  const read = useCallback((no: number) => {
    api.compare(a, b, no).then((answer) => {
      if (!answer.steps) return;
      setPairs((prev) => new Map(prev).set(no, answer.steps!));
      setPairSql((prev) => new Map(prev).set(no, answer.sql.slice(2)));
    }, (e: Error) => setError(e.message));
  }, [a, b]);

  useEffect(() => {
    const ac = new AbortController();
    api.compare(a, b, null, ac.signal).then((answer) => {
      const loaded = { a: treeOf(answer, a), b: treeOf(answer, b), sql: answer.sql };
      setData(loaded);
      // Two short sessions open with every pair of turns open; a long one keeps them closed.
      const small = Math.max(...[loaded.a, loaded.b].map((t) => Number(t.main.row.steps ?? 0))) <= OPEN_ALL_STEPS;
      const numbers = small ? [...new Set([...loaded.a.main.turns, ...loaded.b.main.turns].map((t) => t.no))] : [];
      setOpen(new Set(numbers));
      numbers.forEach(read);
    }, (e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [a, b, read]);

  const rows = useMemo(() => (data ? planRows(data.a.main.turns, data.b.main.turns, { pairs, open, shown }) : []), [data, pairs, open, shown]);
  const left = useMemo(() => sideLane(rows.map((r) => r.left), data?.a.main.turns[0]?.ctxFirst ?? 0), [rows, data]);
  const right = useMemo(() => sideLane(rows.map((r) => r.right), data?.b.main.turns[0]?.ctxFirst ?? 0), [rows, data]);

  const from = window.history.state as From | null;
  const back = <button type="button" className="ag-back" onClick={() => go(from?.from ?? '/agents/sessions')}>← {from?.label ?? 'Sessions'}</button>;
  if (error && !data) return <div className="ag-spage"><header className="ag-shead"><div className="ag-stitle">{back}<h1>Compare sessions</h1></div></header><div className="error" role="alert">{error}</div></div>;
  if (!data) return <div className="ag-spage"><header className="ag-shead"><div className="ag-stitle">{back}<h1>Compare sessions</h1></div></header><div className="empty">Loading…</div></div>;

  const scale = Math.max(data.a.scale, data.b.scale);
  const here: From = { from: `/agents/compare${search}`, label: 'Compare' };
  const twist = (no: number) => {
    const opening = !open.has(no);
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(no)) next.add(no);
      return next;
    });
    if (opening && !pairs.has(no)) read(no);
  };
  const openIn = (tree: Tree, cell: NonNullable<Cell>) => {
    const sid = tree.main.sid;
    if (cell.type === 'step') go(sessionUrl(sid, stepKey(sid, cell.step.seq)), { state: here });
    if (cell.type === 'cut') go(sessionUrl(sid, cutKey(sid, cell.seq)), { state: here });
  };
  const side = (row: PlanRow, s: SideRow, tree: Tree, first: boolean) => {
    const pad = { '--g': `${indent(0)}px`, height: `${HEIGHT[row.kind]}px` } as CSSProperties;
    const cell = s.cell;
    const graph = (
      <LaneGraph kind={row.kind} lane={0} from={s.from} at={s.at} to={s.to} above={s.above} below={s.below} pass={cell ? [] : [s.pass]} scale={scale} empty={!cell}
        node={cell?.type === 'turn' ? { turn: cell.turn.no, selected: false } : cell?.type === 'step' ? { dot: cell.step.failed ? 'bad' : cell.step.tools === 'reply' ? 'reply' : '' } : null} />
    );
    if (!cell) return <div className="ag-trow gap" style={pad}>{graph}</div>;
    if (cell.type === 'more') return <div className="ag-trow more" style={pad}>{graph}{words(cell, s, row, first, () => setShown((prev) => new Map(prev).set(row.no, (prev.get(row.no) ?? PAIRS_PAGE) + PAIRS_PAGE)))}</div>;
    const act = cell.type === 'turn' ? () => twist(row.no) : () => openIn(tree, cell);
    return (
      <div className={`ag-trow ${cell.type}${row.kind === 'closed' ? ' closed' : ''}`} style={pad} tabIndex={0} role={cell.type === 'turn' ? 'button' : 'link'}
        aria-expanded={cell.type === 'turn' ? cell.open : undefined} title={cell.type === 'turn' ? undefined : 'Open in its session'}
        onClick={act} onKeyDown={(e) => { if (e.key === 'Enter') act(); }}>
        {graph}{words(cell, s, row, first, () => undefined)}
      </div>
    );
  };
  const head = (name: string, tree: Tree) => (
    <div>
      <b className="ag-ab">{name}</b>
      <button type="button" className="ag-clink" onClick={() => go(sessionUrl(tree.main.sid, null), { state: here })}>{sessionName(tree.main.row)}</button>
      <span className="ag-cend" title={text(tree.main.row.last_output)}>Last output: {plainLine(text(tree.main.row.last_output)).slice(0, 200)}</span>
    </div>
  );

  return (
    <div className="ag-spage">
      <header className="ag-shead">
        <div className="ag-stitle">
          {back}<h1>Compare sessions</h1>
          <span className="ag-head-tools">
            <button type="button" onClick={() => go(`/agents/compare?a=${encodeURIComponent(b)}&b=${encodeURIComponent(a)}`, { replace: true })}>Swap A and B</button>
            <button type="button" aria-haspopup="dialog" onClick={() => setShowSql(true)}>SQL</button>
          </span>
        </div>
        <div className="ag-cfacts">
          <table className="ag-table" aria-label="The two sessions">
            <thead><tr><th /><th>Session</th>{FACTS.map((f) => <th key={f.label} className={f.kind === 'number' ? 'num' : ''}>{f.label}</th>)}</tr></thead>
            <tbody>
              {([['A', data.a], ['B', data.b]] as const).map(([name, tree]) => (
                <tr key={name}>
                  <td><b className="ag-ab">{name}</b></td>
                  <td><button type="button" className="ag-clink" title={`session_id ${tree.main.sid}`} onClick={() => go(sessionUrl(tree.main.sid, null), { state: here })}>{sessionName(tree.main.row)}</button></td>
                  {FACTS.map((f) => <td key={f.label} className={f.kind === 'number' ? 'num' : f.kind === 'none' ? 'ag-time' : ''}>{f.show(f.value(tree.main.row))}</td>)}
                </tr>
              ))}
              <tr className="ag-delta">
                <td colSpan={2}>B compared with A</td>
                {FACTS.map((f) => {
                  const d = delta(f, data.a.main.row, data.b.main.row);
                  return <td key={f.label} className={f.kind === 'number' ? 'num' : ''}>{d === '0' || d === 'same' ? <span className="ag-zero">{d}</span> : d}</td>;
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </header>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="ag-otools ag-ckey">
        <span><svg width={20} height={18} aria-hidden="true"><circle className="ag-stop" cx={10} cy={9} r={7.5} /><text className="ag-no" x={10} y={12.5}>1</text></svg>Turn</span>
        <span><svg width={14} height={18} aria-hidden="true"><circle className="ag-dot" cx={7} cy={9} r={3.5} /></svg>Step</span>
        <span><svg width={30} height={18} aria-hidden="true"><path className="ag-rl" d="M2,8L28,2V16L2,10Z" /></svg>Line width: context size</span>
        <span><i className="ag-swatch" />Differs from the other session</span>
      </div>
      <div className="ag-cbody">
        <div className="ag-cgrid">
          <div className="ag-chead">{head('A', data.a)}{head('B', data.b)}</div>
          {rows.map((row, i) => {
            // The button of a "more" row sits on the first side that still has steps to show.
            const firstLeft = row.kind === 'more' && row.left !== null;
            return (
              <div className={`ag-crow${row.differs ? ' dif' : ''}`} key={`${row.no}:${row.kind}:${i}`}>
                {side(row, left[i]!, data.a, firstLeft)}{side(row, right[i]!, data.b, row.kind === 'more' && !firstLeft)}
              </div>
            );
          })}
        </div>
      </div>
      {showSql && <SqlDialog statements={[...data.sql, ...[...open].sort((x, y) => x - y).flatMap((no) => pairSql.get(no) ?? [])]} onClose={() => setShowSql(false)} />}
    </div>
  );
}
