import { type CSSProperties, type KeyboardEvent, memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { duration, plainLine, plural, tokens } from '../../lib/agents/format.ts';
import {
  chain, half, HEIGHT, indent, kindOf, type LaneRow, rowTops, stepFailed, stepLabel, stepRepeats, stepTotalUs, STEPS_PAGE, twistOf, windowOf,
} from '../../lib/agents/lanes.ts';
import { LaneGraph } from './LaneGraph.tsx';

/** Characters of a user's input shown on its turn's row. */
const TITLE_CHARS = 200;
/** Pixels of rows drawn above and below the window, so a scroll does not show a gap. */
const OVERSCAN = 600;
/** The padding above the first row, and the room kept between the selected row and the window's edge. */
const PAD_TOP = 10;
const EDGE = 56;

interface Actions {
  onSelect: (row: LaneRow) => void;
  /** Opens or closes a turn or a sub-agent branch. */
  onTwist: (key: string) => void;
  /** Reads the next steps of a turn. */
  onMore: (sid: string, turn: number) => void;
}

/** The drawing at the left of a row: lanes that pass by, the row's own lane, a branch, the node. */
function Graph({ row, selected, scale }: { row: LaneRow; selected: boolean; scale: number }) {
  const child = row.type === 'step' ? row.child : null;
  const dot = row.type !== 'step' ? '' : stepFailed(row.step) ? 'bad' : stepRepeats(row.step) ? 'warn' : row.step.tools.length === 0 ? 'reply' : '';
  return (
    <LaneGraph kind={kindOf(row)} lane={row.lane} from={row.from} at={row.at} to={row.to} above={row.above} below={row.below} pass={row.pass} scale={scale}
      node={row.type === 'turn' ? { turn: row.turn.no, selected } : row.type === 'step' ? { dot } : null}
      branch={child && row.type === 'step' ? { open: row.open, width: Math.max(2, 2 * half(child.turns[0]?.ctxFirst ?? 0, scale)) } : null} />
  );
}

function Twist({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className="ag-tw" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {label}<i>{open ? '▾' : '▸'}</i>
    </button>
  );
}

/** The words of a turn, a step or a compaction beside its drawing. */
function words(row: LaneRow, main: string, a: Actions): ReactNode {
  if (row.type === 'cut') {
    return <><span className="ag-tl">Compaction</span><span className="ag-tm">{tokens(row.before)} → {tokens(row.after)} tokens</span></>;
  }
  if (row.type === 'turn') {
    const t = row.turn;
    const title = plainLine(t.userInput).slice(0, TITLE_CHARS) || 'No user input';
    const c = chain(t.tools);
    return (
      <>
        <span className="ag-tl ag-tt">{title}</span>
        <span className="ag-tm">
          {t.failedCalls > 0 && <b className="bad">{t.failedCalls} failed</b>}
          {t.steps > 0 ? <Twist open={row.open} label={plural(t.steps, 'step')} onClick={() => a.onTwist(row.key)} /> : <span>no steps</span>}
        </span>
        <span className="ag-td">{duration(t.activeUs)}</span>
        {!row.open && (
          <span className="ag-sub">
            <span className="ag-chain">
              {c.links.map((l, i) => (
                <span key={i}>{i > 0 && <i>→</i>}<span className={l.bad ? 'bad' : ''}>{l.name}{l.n > 1 ? ` ×${l.n}` : ''}{l.bad ? ' failed' : ''}</span></span>
              ))}
              {c.more && <><i>→</i>…</>}
              {c.links.length === 0 && t.steps > 0 && <span>reply</span>}
            </span>
            {row.inner > 0 && <span className="ag-cc">{plural(row.inner, 'compaction')}</span>}
          </span>
        )}
      </>
    );
  }
  if (row.type === 'step') {
    const s = row.step;
    const label = stepLabel(s, row.child, s.sid === main);
    const twist = twistOf(row);
    return (
      <>
        <span className="ag-tl">
          <span className="ag-sn">{s.no}</span>
          {label.tool ? <><code>{label.tool}</code> {label.text}</> : <span className="ag-dim">{label.text}</span>}
          {label.extra > 0 && <span className="ag-dim"> +{label.extra}</span>}
        </span>
        <span className="ag-tm">
          {stepFailed(s) && <b className="bad">failed</b>}
          {stepRepeats(s) && <b className="warn">repeated</b>}
          {row.child && twist && <Twist open={row.open} label={plural(row.child.turns.reduce((n, t) => n + t.steps, 0), 'step')} onClick={() => a.onTwist(twist)} />}
        </span>
        <span className="ag-td">{duration(stepTotalUs(s))}</span>
      </>
    );
  }
  return row.loaded === 0 ? <span className="ag-dim">Reading the steps…</span>
    : <button type="button" onClick={() => a.onMore(row.sid, row.turn)}>Show {Math.min(STEPS_PAGE, row.left)} more of {plural(row.left, 'step')}</button>;
}

interface RowProps extends Actions { row: LaneRow; selected: boolean; scale: number; main: string }

/** A row is drawn again only when its lane, its content or its selection changes. */
function sameRow(a: RowProps, b: RowProps): boolean {
  const x = a.row;
  const y = b.row;
  if (a.selected !== b.selected || a.scale !== b.scale || x.type !== y.type || x.key !== y.key || x.lane !== y.lane) return false;
  if (x.from !== y.from || x.at !== y.at || x.to !== y.to || x.above !== y.above || x.below !== y.below || x.pass.join() !== y.pass.join()) return false;
  if (x.type === 'turn' && y.type === 'turn') return x.turn === y.turn && x.open === y.open && x.inner === y.inner;
  if (x.type === 'step' && y.type === 'step') return x.step === y.step && x.open === y.open && x.child === y.child;
  if (x.type === 'cut' && y.type === 'cut') return x.before === y.before && x.after === y.after;
  if (x.type === 'more' && y.type === 'more') return x.loaded === y.loaded && x.left === y.left;
  return false;
}

const Line = memo(function Line({ row, selected, scale, main, ...a }: RowProps) {
  const kind = kindOf(row);
  const pad = { '--g': `${indent(row.lane)}px` } as CSSProperties;
  if (row.type === 'more') return <div className="ag-trow more" style={pad}><Graph row={row} selected={false} scale={scale} />{words(row, main, a)}</div>;
  return (
    <div className={`ag-trow ${row.type}${kind === 'closed' ? ' closed' : ''}${selected ? ' sel' : ''}`} role="treeitem" aria-selected={selected}
      aria-expanded={twistOf(row) && !(row.type === 'turn' && row.turn.steps === 0) ? row.type !== 'cut' && row.open : undefined} data-key={row.key} style={pad} onClick={() => a.onSelect(row)}>
      <Graph row={row} selected={selected} scale={scale} />{words(row, main, a)}
    </div>
  );
}, sameRow);

interface Props extends Actions {
  rows: LaneRow[];
  /** Key of the selected row. */
  selected: string | null;
  scale: number;
  /** Id of the main session, whose last steps answer the user. */
  main: string;
}

/** What the drawing means, one entry per sign. */
function Legend() {
  return (
    <div className="ag-otools">
      <svg width={20} height={18} aria-hidden="true"><circle className="ag-stop" cx={10} cy={9} r={7.5} /><text className="ag-no" x={10} y={12.5}>1</text></svg>Turn
      <svg width={14} height={18} aria-hidden="true"><circle className="ag-dot" cx={7} cy={9} r={3.5} /></svg>Step
      <svg width={30} height={18} aria-hidden="true"><path className="ag-rl" d="M2,8L28,2V16L2,10Z" /></svg>Line width: context size
    </div>
  );
}

/**
 * The left side of the session page: the trajectory as lanes. Only the rows near the window are
 * drawn. Arrow keys move along the rows and open or close them.
 */
export function Lanes({ rows, selected, scale, main, onSelect, onTwist, onMore }: Props) {
  const tree = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 900 });
  const tops = useMemo(() => rowTops(rows), [rows]);
  const total = tops[tops.length - 1]!;
  const [start, end] = windowOf(tops, view.top - PAD_TOP, view.height, OVERSCAN);
  const measure = () => {
    const el = tree.current;
    if (el) setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
  };
  useEffect(() => {
    measure();
    const watch = new ResizeObserver(measure);
    if (tree.current) watch.observe(tree.current);
    return () => watch.disconnect();
  }, []);
  // A new selection is brought into the window once, as soon as its row exists.
  const brought = useRef<string | null>(null);
  useEffect(() => {
    const el = tree.current;
    const at = selected ? rows.findIndex((r) => r.key === selected) : -1;
    if (!el || at < 0 || brought.current === selected) return;
    brought.current = selected;
    const top = tops[at]! + PAD_TOP;
    const bottom = top + HEIGHT[kindOf(rows[at]!)];
    if (top < el.scrollTop + EDGE) el.scrollTop = Math.max(0, top - EDGE);
    else if (bottom > el.scrollTop + el.clientHeight - EDGE) el.scrollTop = bottom - el.clientHeight + EDGE;
  }, [selected, rows, tops]);

  const onKey = (e: KeyboardEvent) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const list = rows.filter((r) => r.type !== 'more');
    const at = list.findIndex((r) => r.key === selected);
    const row = list[at];
    e.preventDefault();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const next = list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) onSelect(next);
      return;
    }
    if (!row) return;
    const twist = twistOf(row);
    const open = row.type !== 'cut' && row.open;
    const empty = row.type === 'turn' && row.turn.steps === 0;
    if (twist && !empty && (e.key === 'ArrowRight') !== open) return onTwist(twist);
    // Left on a closed row goes to the row that holds it.
    const owner = row.type === 'step' && e.key === 'ArrowLeft' ? list.find((r) => twistOf(r) === row.owner) : undefined;
    if (owner) onSelect(owner);
  };

  return (
    <div className="ag-outline">
      <Legend />
      <div className="ag-tree" role="tree" tabIndex={0} aria-label="Turns and steps of the session" ref={tree} onKeyDown={onKey} onScroll={measure}>
        <div style={{ height: tops[start] }} />
        {rows.slice(start, end).map((r) => <Line key={r.key} row={r} selected={r.key === selected} scale={scale} main={main} onSelect={onSelect} onTwist={onTwist} onMore={onMore} />)}
        <div style={{ height: total - tops[end]! }} />
      </div>
    </div>
  );
}
