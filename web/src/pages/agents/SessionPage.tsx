import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api/agents.ts';
import { Lanes } from '../../components/agents/Lanes.tsx';
import { CutPane, StepPane, TurnPane } from '../../components/agents/Pane.tsx';
import { SqlDialog } from '../../components/agents/SqlDialog.tsx';
import { blockOf } from '../../lib/agents/chat.ts';
import { duration, num, plural, stamp, text, timeOf, tokens } from '../../lib/agents/format.ts';
import {
  type Branch, branchKey, buildTree, type Item, itemsKey, itemsOf, type JumpKind, jumpTargets, type LaneRow, laneRows, nextTarget, pagesToRead, reveal,
  STEPS_PAGE, type Tree,
} from '../../lib/agents/lanes.ts';
import { sessionName, sessionUrl } from '../../lib/agents/pages.ts';
import { parseSel, type Selection, selKey, stepKey, turnKey } from '../../lib/agents/select.ts';
import type { Go } from '../../Root.tsx';
import type { From } from './TablePage.tsx';

/** What the right side reads for the selection. */
type Detail = { key: string } & (
  | { kind: 'turn'; answer: api.TurnAnswer }
  | { kind: 'step'; answer: api.StepAnswer; older: api.Row[] }
  | { kind: 'cut'; answer: api.CompactionAnswer }
  | { kind: 'error'; message: string });

/** Where a selection sits: its branch, its turn, and the ordinal of its model call (null for a turn). */
interface Place { sid: string; turn: number; stepNo: number | null }

const JUMPS: { kind: JumpKind; noun: string }[] = [
  { kind: 'failed', noun: 'failed call' }, { kind: 'repeated', noun: 'repeated call' }, { kind: 'compaction', noun: 'compaction' }, { kind: 'subagent', noun: 'sub-agent' },
];

const toggled = (set: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

/** Whether the contexts of a tree come from request logs. */
function exactness(tree: Tree): string {
  const known = [...tree.branches.values()].flatMap((b) => b.turns).map((t) => t.exact).filter((e): e is boolean => e !== null);
  if (!known.length) return '';
  return known.every(Boolean) ? 'contexts exact' : known.some(Boolean) ? 'contexts partly inferred' : 'contexts inferred';
}

/** The session page: one line of facts, the trajectory as lanes on the left, the selection as a chat on the right. */
export function SessionPage({ id, search, go }: { id: string; search: string; go: Go }) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [treeSql, setTreeSql] = useState<api.Statement[]>([]);
  const [stepsSql, setStepsSql] = useState<api.Statement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rowsByTurn, setRowsByTurn] = useState<ReadonlyMap<string, api.Row[]>>(new Map());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showSql, setShowSql] = useState(false);
  // What the callbacks of the lanes read; the rows keep one identity, so they are not drawn again.
  const live = useRef({ tree, rows: rowsByTurn, reading: new Map<string, Promise<void>>(), places: new Map<string, Place>() });
  // The items of each turn, kept until that turn's rows change, so reading one turn does not rebuild the others.
  const built = useRef(new WeakMap<api.Row[], Item[]>());
  live.current.tree = tree;

  useEffect(() => {
    const ac = new AbortController();
    api.tree(id, ac.signal).then((a) => {
      const t = buildTree(a);
      const grouped = (a.steps ?? []).reduce((m, r) => {
        const k = itemsKey(text(r.session_id), num(r.turn));
        return m.set(k, [...(m.get(k) ?? []), r]);
      }, new Map<string, api.Row[]>());
      live.current.rows = grouped;
      setRowsByTurn(grouped);
      // A small tree opens with its whole structure visible.
      if (a.openAll) setOpen(new Set([...t.main.turns.map((x) => turnKey(x.sid, x.no)), ...[...t.branches.values()].filter((b) => b.parent !== null).map((b) => branchKey(b.sid))]));
      setTreeSql(a.sql);
      setTree(t);
    }, (e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [id]);

  /** Reads the pages of a turn still missing so that its first `steps` steps are on screen. */
  const ensure = useCallback((sid: string, turn: number, steps: number): Promise<void> => {
    const key = itemsKey(sid, turn);
    const next = (live.current.reading.get(key) ?? Promise.resolve()).then(async () => {
      const total = live.current.tree?.branches.get(sid)?.turns.find((t) => t.no === turn)?.steps ?? 0;
      const have = (live.current.rows.get(key) ?? []).filter((r) => r.kind === 'llm_call').length;
      const offsets = pagesToRead(have, steps, total);
      if (!offsets.length) return;
      const answers = await Promise.all(offsets.map((o) => api.turnSteps(sid, turn, o)));
      const rows = new Map(live.current.rows).set(key, [...(live.current.rows.get(key) ?? []), ...answers.flatMap((a) => a.steps)]);
      live.current.rows = rows;
      setRowsByTurn(rows);
      setStepsSql(answers[answers.length - 1]!.sql);
    }).catch((e: Error) => setError(e.message));
    live.current.reading.set(key, next);
    return next;
  }, []);

  const items = useMemo(() => new Map<string, Item[]>([...rowsByTurn].map(([k, rows]) => {
    const known = built.current.get(rows) ?? itemsOf(rows);
    built.current.set(rows, known);
    return [k, known];
  })), [rowsByTurn]);
  const targets = useMemo(() => new Map(JUMPS.map((j) => [j.kind, tree ? jumpTargets(tree, j.kind) : []])), [tree]);
  const rows = useMemo(() => (tree ? laneRows(tree, { items, open }) : []), [tree, items, open]);
  const param = new URLSearchParams(search).get('sel');
  const sel: Selection | null = useMemo(() => {
    const first = tree?.main.turns[0];
    return parseSel(param) ?? (tree && first ? { kind: 'turn', sid: first.sid, turn: first.no } : null);
  }, [param, tree]);
  const key = sel ? selKey(sel) : null;

  const select = useCallback((k: string) => go(sessionUrl(id, k), { replace: true }), [go, id]);
  const onSelect = useCallback((row: LaneRow) => select(row.key), [select]);
  const onTwist = useCallback((k: string) => {
    setOpen((prev) => toggled(prev, k));
    const t = live.current.tree;
    const turn = parseSel(k);
    // Opening a turn or a sub-agent branch reads its first steps.
    if (turn?.kind === 'turn') void ensure(turn.sid, turn.turn, STEPS_PAGE);
    else t?.branches.get(k.slice(2))?.turns.forEach((x) => void ensure(x.sid, x.no, STEPS_PAGE));
  }, [ensure]);
  const onMore = useCallback((sid: string, turn: number) => {
    const have = (live.current.rows.get(itemsKey(sid, turn)) ?? []).filter((r) => r.kind === 'llm_call').length;
    void ensure(sid, turn, have + STEPS_PAGE);
  }, [ensure]);

  // What the right side reads for the selection.
  useEffect(() => {
    if (!sel || !key) return;
    const ac = new AbortController();
    const done = (d: Detail) => { if (!ac.signal.aborted) setDetail(d); };
    const fail = (e: Error) => done({ key, kind: 'error', message: e.message });
    if (sel.kind === 'turn') api.turn(sel.sid, sel.turn, ac.signal).then((answer) => done({ key, kind: 'turn', answer }), fail);
    else if (sel.kind === 'step') api.step(sel.sid, sel.seq, 0, ac.signal).then((answer) => done({ key, kind: 'step', answer, older: [] }), fail);
    else api.compaction(sel.sid, sel.seq, ac.signal).then((answer) => done({ key, kind: 'cut', answer }), fail);
    return () => ac.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the selection sits, as soon as it is known: from a jump, from the rows on screen, or from what the right side read.
  const place: Place | null = useMemo(() => {
    if (!sel || !key) return null;
    if (sel.kind === 'turn') return { sid: sel.sid, turn: sel.turn, stepNo: null };
    const hint = live.current.places.get(key);
    if (hint) return hint;
    const row = rows.find((r) => r.key === key);
    if (row?.type === 'step') return { sid: row.step.sid, turn: row.step.turn, stepNo: row.step.no };
    if (detail?.key !== key) return null;
    const e = detail.kind === 'step' ? detail.answer.step : detail.kind === 'cut' ? detail.answer.event : null;
    return e ? { sid: sel.sid, turn: num(e.turn), stepNo: num(e.step) } : null;
  }, [key, detail, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // A selection opens the way to itself once, when it is made; closing a row afterwards is left alone.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!tree || !key || shown.current === key) return;
    // A selection that already has a row needs no way opened: opening its turn would push it out of the window.
    if (rows.some((r) => r.key === key)) {
      shown.current = key;
      return;
    }
    if (!place) return;
    shown.current = key;
    const way = reveal(tree, place);
    if (way.open.length) setOpen((prev) => new Set([...prev, ...way.open]));
    way.load.forEach((l) => void ensure(l.sid, l.turn, l.steps));
  }, [tree, key, place, rows, ensure]);

  const jump = (kind: JumpKind) => {
    if (!tree) return;
    const target = nextTarget(targets.get(kind) ?? [], key);
    if (!target) return;
    live.current.places.set(target.key, { sid: target.sid, turn: target.turn, stepNo: target.stepNo });
    select(target.key);
  };
  const older = () => {
    if (detail?.kind !== 'step' || !sel || sel.kind !== 'step') return;
    setLoadingOlder(true);
    api.step(sel.sid, sel.seq, detail.answer.input.length + detail.older.length).then(
      (a) => setDetail((d) => (d && d.key === detail.key && d.kind === 'step' ? { ...d, older: [...d.older, ...a.input] } : d)),
      (e: Error) => setError(e.message),
    ).finally(() => setLoadingOlder(false));
  };

  const from = window.history.state as From | null;
  const back = <button type="button" className="ag-back" onClick={() => go(from?.from ?? '/agents/sessions')}>← {from?.label ?? 'Sessions'}</button>;
  if (error && !tree) return <div className="ag-spage"><header className="ag-shead"><div className="ag-stitle">{back}<h1>Session</h1></div></header><div className="error" role="alert">{error}</div></div>;
  if (!tree) return <div className="ag-spage"><header className="ag-shead"><div className="ag-stitle">{back}<h1>Session</h1></div></header><div className="empty">Loading…</div></div>;

  const m = tree.main.row;
  const started = timeOf(m.started_at);
  const ended = timeOf(m.last_event_at);
  const counts: Record<JumpKind, number> = {
    failed: num(m.tool_errors), repeated: tree.marks.filter((x) => x.repeated).length, compaction: num(m.compactions), subagent: num(m.subagents),
  };
  const branch = sel ? tree.branches.get(sel.sid) : undefined;
  const inner = branch !== undefined && branch.parent !== null;
  const spawn = inner ? tree.spawns.get(branch.sid) : undefined;
  const fresh = detail?.key === key ? detail : null;
  const stepNo = fresh?.kind === 'step' ? num(fresh.answer.step.step) : null;
  const turnNo = sel?.kind === 'turn' ? sel.turn : place?.turn ?? null;
  const output = fresh?.kind === 'step' ? fresh.answer.output.map(blockOf) : [];
  const childAt = (callSeq: number): Branch | null => [...tree.branches.values()].find((b) => b.parent === sel?.sid && b.parentSeq === callSeq) ?? null;

  return (
    <div className="ag-spage">
      <header className="ag-shead">
        <div className="ag-stitle">
          {back}<h1>{sessionName({ ...m, first_input: tree.main.turns[0]?.userInput })}</h1><code title="session_id">{tree.main.sid}</code>
          <span className="ag-head-tools"><button type="button" aria-haspopup="dialog" onClick={() => setShowSql(true)}>SQL</button></span>
        </div>
        <p className="ag-sfacts">
          {started !== null && ended !== null ? `${stamp(started)} to ${stamp(ended)} · ` : ''}{plural(num(m.turns), 'turn')} · {plural(num(m.steps), 'step')} · {plural(num(m.tool_calls), 'tool call')}
          {' · '}{duration(num(m.active_us))} active · {tokens(num(m.input_tokens) + num(m.output_tokens))} tokens · peak context {tokens(num(m.peak_ctx_tokens))}
          {m.model ? ` · ${text(m.model)}` : ''}{m.user_id ? ` · ${text(m.user_id)}` : ''}{exactness(tree) ? ` · ${exactness(tree)}` : ''}
        </p>
        {JUMPS.some((j) => counts[j.kind] > 0) && (
          <p className="ag-jump">Jump to{JUMPS.filter((j) => counts[j.kind] > 0).map((j) => (
            <button type="button" key={j.kind} onClick={() => jump(j.kind)}>{plural(counts[j.kind], j.noun)}</button>
          ))}{tree.marksCut && <span>Only the first 2,000 of these places are known to this page.</span>}</p>
        )}
      </header>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="ag-sbody">
        <Lanes rows={rows} selected={key} scale={tree.scale} main={tree.main.sid} onSelect={onSelect} onTwist={onTwist} onMore={onMore} />
        <div className="ag-pane" key={key}>
          {sel && sel.kind !== 'turn' && (
            <p className="ag-crumbs">
              {spawn && <><button type="button" onClick={() => select(turnKey(spawn.sid, spawn.turn))}>Turn {spawn.turn}</button> › <button type="button" onClick={() => select(stepKey(spawn.sid, spawn.parentSeq ?? spawn.seq))}>Step {spawn.step} · {branch?.name}</button></>}
              {!inner && turnNo !== null && <button type="button" onClick={() => select(turnKey(sel.sid, turnNo))}>Turn {turnNo}</button>}
            </p>
          )}
          <h2>
            {!sel ? 'No turns' : sel.kind === 'turn' ? `${inner ? `${branch?.name}: turn` : 'Turn'} ${sel.turn}` : sel.kind === 'cut' ? 'Compaction' : `Step${stepNo === null ? '' : ` ${stepNo}`}`}
            {output.some((b) => b.role === 'tool' && b.failed) && <b className="bad">failed</b>}
            {output.some((b) => b.call?.repeatOf !== null && b.call?.repeatOf !== undefined) && <b className="warn">repeated</b>}
          </h2>
          {!sel && <div className="ag-notice">This session has no turns.</div>}
          {sel && !fresh && <div className="ag-notice">Loading…</div>}
          {fresh?.kind === 'error' && <div className="error" role="alert">{fresh.message}</div>}
          {fresh?.kind === 'turn' && sel?.kind === 'turn' && (
            <TurnPane turn={branch?.turns.find((t) => t.no === sel.turn)} answer={fresh.answer} inner={inner} open={open.has(turnKey(sel.sid, sel.turn))}
              onTwist={inner ? null : () => onTwist(turnKey(sel.sid, sel.turn))} />
          )}
          {fresh?.kind === 'step' && (
            <StepPane answer={fresh.answer} older={fresh.older} onOlder={older} loadingOlder={loadingOlder} childOf={childAt}
              isOpen={(b) => open.has(branchKey(b.sid))} onTwist={(b) => onTwist(branchKey(b.sid))} />
          )}
          {fresh?.kind === 'cut' && <CutPane answer={fresh.answer} />}
        </div>
      </div>
      {showSql && <SqlDialog statements={[...treeSql, ...stepsSql, ...(fresh && fresh.kind !== 'error' ? fresh.answer.sql : [])]} onClose={() => setShowSql(false)} />}
    </div>
  );
}
