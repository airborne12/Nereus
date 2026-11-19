// The structure of one trajectory as lanes, after the paper's Figure 1: one lane per session, a
// numbered node per turn, a small node per step, a branch where a step starts a sub-agent. The
// width of a lane is the size of the context. This module builds the rows; a component draws them.

import type { Row } from '../../api/agents.ts';
import { num, text, timeOf } from './format.ts';
import { parseSel, cutKey, stepKey, turnKey } from './select.ts';

export interface ToolCall { seq: number; name: string; resource: string; failed: boolean; repeatOf: number | null; repeatVisible: boolean; durationUs: number }

/** One model call with the tool calls it issued. */
export interface Step {
  sid: string;
  seq: number;
  /** Ordinal of the model call in its branch. */
  no: number;
  turn: number;
  ts: number | null;
  /** Tokens of the request: the size of the context. */
  ctx: number;
  stop: string;
  durationUs: number;
  tools: ToolCall[];
}
export interface Cut { sid: string; seq: number; turn: number }
export type Item = { type: 'step'; step: Step } | { type: 'cut'; cut: Cut };

export interface Turn {
  sid: string;
  no: number;
  userInput: string;
  steps: number;
  failedCalls: number;
  compactions: number;
  activeUs: number;
  ctxFirst: number;
  ctxLast: number;
  /** The turn's tool calls in order, as `name` or `name failed`, joined by commas. */
  tools: string;
  /** Ordinal in the branch of the turn's first model call. */
  firstStep: number;
  /** Sequence number of the turn's last model call. */
  lastCall: number;
  /** Whether every context of the turn comes from a request log; null without a model call. */
  exact: boolean | null;
  startedAt: number | null;
}

export interface Branch {
  sid: string;
  kind: string;
  name: string;
  model: string;
  parent: string | null;
  parentSeq: number | null;
  turns: Turn[];
  /** The session row as the API sent it. */
  row: Row;
}

/** A place the Jump to buttons visit, or where a sub-agent branch leaves its parent. */
export interface Mark { sid: string; seq: number; turn: number; step: number; kind: string; parentSeq: number | null; failed: boolean; repeated: boolean; child: string | null }

export interface Tree {
  main: Branch;
  branches: ReadonlyMap<string, Branch>;
  /** The sub-agent branch a tool call started, by `callKey` of the call. */
  children: ReadonlyMap<string, Branch>;
  marks: Mark[];
  /** The call that started each sub-agent branch, by the branch's session id. */
  spawns: ReadonlyMap<string, Mark>;
  /** The tree has more marks than the API sends: counts and jumps taken from them are partial. */
  marksCut: boolean;
  /** Tokens of the widest lane. */
  scale: number;
}

/** A tool call of a branch, as the key of the sub-agent it started. */
const callKey = (sid: string, seq: number): string => `${sid}#${seq}`;

/** What of the tree is on screen: the items read so far by turn, and what is open. */
export interface View { items: ReadonlyMap<string, Item[]>; open: ReadonlySet<string> }

export const branchKey = (sid: string): string => `b:${sid}`;
export const itemsKey = (sid: string, turn: number): string => `${sid}#${turn}`;
/** Steps of a turn the page reads at a time. */
export const STEPS_PAGE = 100;
/** The narrowest context a full-width lane stands for. */
const MIN_SCALE = 200_000;

const turnOf = (r: Row): Turn => ({
  sid: text(r.session_id), no: num(r.turn), userInput: text(r.user_input), steps: num(r.steps), failedCalls: num(r.failed_calls),
  compactions: num(r.compactions), activeUs: num(r.active_us), ctxFirst: num(r.ctx_first), ctxLast: num(r.ctx_last), tools: text(r.tools),
  firstStep: num(r.first_step), lastCall: num(r.last_call), exact: r.ctx_exact === null || r.ctx_exact === undefined ? null : num(r.ctx_exact) === 1,
  startedAt: timeOf(r.started_at),
});

/** The tree of a session from the rows of its tree answer. */
export function buildTree(answer: { sessions: readonly Row[]; turns: readonly Row[]; marks: readonly Row[]; marksCut?: boolean }): Tree {
  const turns = answer.turns.map(turnOf);
  const list = answer.sessions.map((s): Branch => ({
    sid: text(s.session_id), kind: text(s.kind), name: text(s.agent_name) || text(s.title) || text(s.kind), model: text(s.model),
    parent: s.parent_id === null || s.parent_id === undefined ? null : text(s.parent_id),
    parentSeq: s.parent_seq === null || s.parent_seq === undefined ? null : num(s.parent_seq),
    turns: turns.filter((t) => t.sid === text(s.session_id)).sort((a, b) => a.no - b.no), row: s,
  }));
  const main = list.find((b) => b.kind === 'main') ?? list[0];
  if (!main) throw new Error('a session tree needs a session');
  const marks = answer.marks.map((m): Mark => ({
    sid: text(m.session_id), seq: num(m.seq), turn: num(m.turn), step: num(m.step), kind: text(m.kind),
    parentSeq: m.parent_seq === null || m.parent_seq === undefined ? null : num(m.parent_seq),
    failed: num(m.failed) === 1, repeated: num(m.repeated) === 1, child: m.child === null || m.child === undefined ? null : text(m.child),
  }));
  const widest = Math.max(MIN_SCALE, ...list.map((b) => num(b.row.peak_ctx_tokens)), ...turns.map((t) => Math.max(t.ctxFirst, t.ctxLast)));
  const children = new Map(list.filter((b) => b.parent !== null && b.parentSeq !== null).map((b) => [callKey(b.parent!, b.parentSeq!), b]));
  const spawns = new Map(marks.filter((m) => m.child !== null).map((m) => [m.child!, m]));
  return { main, branches: new Map(list.map((b) => [b.sid, b])), children, marks, spawns, marksCut: answer.marksCut === true, scale: widest };
}

const toolOf = (r: Row): ToolCall => ({
  seq: num(r.seq), name: text(r.name), resource: text(r.resource), failed: r.status === 'error',
  repeatOf: r.repeat_of === null || r.repeat_of === undefined ? null : num(r.repeat_of), repeatVisible: num(r.repeat_visible) === 1, durationUs: num(r.duration_us),
});

/** The light step rows of one turn, in order, as steps with their tool calls and compactions. */
export function itemsOf(rows: readonly Row[]): Item[] {
  // The tool calls by the model call that issued them, gathered in one pass over the rows.
  const calls = new Map<number, ToolCall[]>();
  for (const r of rows) {
    if (r.kind !== 'tool_call') continue;
    const of = num(r.parent_seq);
    const list = calls.get(of);
    if (list) list.push(toolOf(r));
    else calls.set(of, [toolOf(r)]);
  }
  return rows.flatMap((r): Item[] => {
    const seq = num(r.seq);
    if (r.kind === 'compaction') return [{ type: 'cut', cut: { sid: text(r.session_id), seq, turn: num(r.turn) } }];
    if (r.kind !== 'llm_call') return [];
    return [{
      type: 'step',
      step: {
        sid: text(r.session_id), seq, no: num(r.step), turn: num(r.turn), ts: timeOf(r.ts), ctx: num(r.ctx_tokens), stop: text(r.stop_reason),
        durationUs: num(r.duration_us), tools: calls.get(seq) ?? [],
      },
    }];
  });
}

export const stepFailed = (s: Step): boolean => s.tools.some((t) => t.failed);
export const stepRepeats = (s: Step): boolean => s.tools.some((t) => t.repeatOf !== null);
/** Model time plus the time of the calls the step issued. */
export const stepTotalUs = (s: Step): number => s.durationUs + s.tools.reduce((a, t) => a + t.durationUs, 0);
const stepsIn = (items: readonly Item[] | undefined): number => (items ?? []).filter((i) => i.type === 'step').length;

/** The sub-agent branches a step started, in the order of their calls; a model call may start several at once. */
export function childrenOf(tree: Tree, s: Step): Branch[] {
  return s.tools.flatMap((t) => {
    const child = tree.children.get(callKey(s.sid, t.seq));
    return child ? [child] : [];
  });
}

interface Geometry {
  lane: number;
  /** Context size at the top edge, at the node and at the bottom edge of the row. */
  from: number;
  at: number;
  to: number;
  /** For each lane to the left: the context size of the lane passing through, or null when it has ended. */
  pass: (number | null)[];
  above: boolean;
  below: boolean;
}

type Content =
  | { type: 'turn'; key: string; turn: Turn; open: boolean; /** Compactions inside the turn that have no row of their own. */ inner: number }
  | {
    type: 'step'; key: string; step: Step;
    /** The sub-agents the step started. */
    children: Branch[];
    /** The only one, when there is exactly one: it opens from the step's own row. */
    child: Branch | null;
    open: boolean;
    /** The row that holds this step: its turn, or its branch. */
    owner: string;
  }
  // One of several sub-agents a step started: the row where its lane begins. Its key is that of its first turn.
  | { type: 'branch'; key: string; branch: Branch; open: boolean; owner: string }
  | { type: 'cut'; key: string; cut: Cut; before: number; after: number }
  | { type: 'more'; key: string; sid: string; turn: number; /** Steps read so far and still to read. */ loaded: number; left: number };

export type LaneRow = Content & Geometry;

interface Draft { content: Content; lane: number; from: number; at: number; to: number; through: number[]; /** The lane begins at this row. */ first: boolean }

/** The visible rows in order. Each row knows its lane and the context size before, at and after it. */
export function laneRows(tree: Tree, view: View): LaneRow[] {
  const out: Draft[] = [];
  // The compactions of the main session by turn, read once for the whole walk.
  const cuts = new Map<number, Mark[]>();
  for (const m of tree.marks) if (m.kind === 'compaction' && m.sid === tree.main.sid) cuts.set(m.turn, [...(cuts.get(m.turn) ?? []), m]);
  // The running context size of each lane; local to this walk.
  const cur: number[] = [tree.main.turns[0]?.ctxFirst ?? 0];
  const add = (content: Content, lane: number, at: number, to: number, first = false) => {
    out.push({ content, lane, from: cur[lane] ?? at, at, to, through: cur.slice(0, lane), first });
    cur[lane] = to;
  };
  const cut = (c: Cut, lane: number, after: number | null) => {
    const before = cur[lane] ?? 0;
    add({ type: 'cut', key: cutKey(c.sid, c.seq), cut: c, before, after: after ?? before }, lane, before, after ?? before);
  };
  // The turns of a sub-agent branch, one after another in its lane.
  const branch = (b: Branch, lane: number) => b.turns.forEach((t, j) => items(t, lane, branchKey(b.sid), b.turns[j + 1]?.ctxFirst ?? null));
  // The steps and compactions of one turn; `next` is the context size after the turn, when known.
  const items = (t: Turn, lane: number, owner: string, next: number | null): number => {
    const list = view.items.get(itemsKey(t.sid, t.no));
    (list ?? []).forEach((item, i) => {
      if (item.type === 'cut') {
        const later = list!.slice(i + 1).find((x) => x.type === 'step');
        return cut(item.cut, lane, later?.type === 'step' ? later.step.ctx : next);
      }
      const s = item.step;
      const kids = childrenOf(tree, s);
      const only = kids.length === 1 ? kids[0]! : null;
      const open = only !== null && view.open.has(branchKey(only.sid));
      add({ type: 'step', key: stepKey(s.sid, s.seq), step: s, children: kids, child: only, open, owner }, lane, s.ctx, s.ctx);
      if (only && open) {
        cur[lane + 1] = only.turns[0]?.ctxFirst ?? 0;
        branch(only, lane + 1);
      }
      // Several sub-agents of one step each get a row of their own, where their lane begins.
      if (kids.length > 1) {
        kids.forEach((kid) => {
          const start = kid.turns[0]?.ctxFirst ?? 0;
          const kidOpen = view.open.has(branchKey(kid.sid));
          cur[lane + 1] = start;
          add({ type: 'branch', key: turnKey(kid.sid, kid.turns[0]?.no ?? 1), branch: kid, open: kidOpen, owner }, lane + 1, start, start, true);
          if (kidOpen) branch(kid, lane + 1);
        });
      }
    });
    const loaded = stepsIn(list);
    if (loaded < t.steps) add({ type: 'more', key: `m:${t.sid}:${t.no}`, sid: t.sid, turn: t.no, loaded, left: t.steps - loaded }, lane, cur[lane] ?? 0, t.ctxLast);
    return loaded;
  };
  tree.main.turns.forEach((t, i) => {
    const key = turnKey(t.sid, t.no);
    const open = view.open.has(key);
    const next = tree.main.turns[i + 1]?.ctxFirst ?? null;
    // A compaction after the turn's last model call ends the turn: it has a row even while the turn is closed.
    // So has every compaction of a turn without a model call, which cannot open.
    const trailing = (cuts.get(t.no) ?? []).filter((m) => t.steps === 0 || m.seq > t.lastCall);
    const start = cur[0] ?? 0;
    add({ type: 'turn', key, turn: t, open, inner: t.compactions - trailing.length }, 0, start, open || t.steps === 0 ? start : t.ctxLast);
    const complete = t.steps > 0 && open && items(t, 0, key, next) >= t.steps;
    if (!complete) trailing.forEach((m) => cut({ sid: m.sid, seq: m.seq, turn: m.turn }, 0, next));
  });
  // A lane is drawn through a row only while a later row still belongs to it.
  const alive: boolean[] = [];
  const rows: LaneRow[] = new Array(out.length);
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const d = out[i]!;
    rows[i] = {
      ...d.content, lane: d.lane, from: d.from, at: d.at, to: d.to, above: i > 0 && !d.first, below: alive[d.lane] === true,
      pass: d.through.map((tok, lane) => (alive[lane] ? tok : null)),
    };
    alive.length = d.lane;
    // A lane that begins at this row does not reach the rows above it.
    alive[d.lane] = !d.first;
  }
  return rows;
}

/** What opens and closes on a row: a turn's own key, or the branch of the sub-agent the row stands for. */
export function twistOf(r: LaneRow): string | null {
  if (r.type === 'turn') return r.key;
  if (r.type === 'branch') return branchKey(r.branch.sid);
  return r.type === 'step' && r.child ? branchKey(r.child.sid) : null;
}

/** A link of a closed turn's chain: a tool, how many times in a row, and whether it failed. */
export interface Link { name: string; n: number; bad: boolean }
/** A closed turn names at most this many links of its chain. */
export const LINKS = 9;

/** The tool calls of a turn as a chain: equal neighbours are counted, a failed call stands alone. */
export function chain(tools: string): { links: Link[]; more: boolean } {
  // Only the first links are shown, so the walk stops once one more than those has begun.
  const links: Link[] = [];
  for (const raw of tools.split(',')) {
    if (!raw) continue;
    const bad = raw.endsWith(' failed');
    const name = bad ? raw.slice(0, -' failed'.length) : raw;
    const last = links[links.length - 1];
    if (last && last.name === name && !last.bad && !bad) links[links.length - 1] = { ...last, n: last.n + 1 };
    else links.push({ name, n: 1, bad });
    if (links.length > LINKS) break;
  }
  return { links: links.slice(0, LINKS), more: links.length > LINKS };
}

/** What a step did, as one short line: its first call, or that it answered. */
export function stepLabel(s: Step, children: readonly Branch[], main: boolean): { tool: string | null; text: string; extra: number } {
  if (children.length === 1) return { tool: 'Agent', text: children[0]!.name, extra: 0 };
  if (children.length > 1) return { tool: 'Agent', text: `${children.length} sub-agents`, extra: s.tools.length - children.length };
  const first = s.tools[0];
  // The last step of a sub-agent answers the agent that started it, not the user.
  if (!first) return { tool: null, text: main ? 'Reply to the user' : 'Return the result', extra: 0 };
  return { tool: first.name, text: first.resource, extra: s.tools.length - 1 };
}

// ---------- finding and visiting

/** What must be open, and how many steps of which turns must be read, to show a place of the tree. */
export interface Reveal { open: string[]; load: { sid: string; turn: number; steps: number }[] }

const nthIn = (b: Branch | undefined, turn: number, stepNo: number): number => Math.max(1, stepNo - (b?.turns.find((t) => t.no === turn)?.firstStep ?? stepNo) + 1);

/**
 * The way to a place: `stepNo` is the ordinal of a model call in its branch, or null for a turn,
 * which is visible without opening anything.
 */
export function reveal(tree: Tree, target: { sid: string; turn: number; stepNo: number | null }): Reveal {
  const branch = tree.branches.get(target.sid);
  if (!branch) return { open: [], load: [] };
  // A sub-agent branch shows once the step that started it does, and the branch is open.
  const spawn = branch.parent === null ? undefined : tree.spawns.get(branch.sid);
  const above: Reveal = spawn ? reveal(tree, { sid: spawn.sid, turn: spawn.turn, stepNo: spawn.step }) : { open: [], load: [] };
  const inner = branch.parent !== null;
  if (target.stepNo === null) return inner ? { open: [...above.open, branchKey(branch.sid)], load: above.load } : above;
  return {
    open: [...above.open, inner ? branchKey(branch.sid) : turnKey(branch.sid, target.turn)],
    load: [...above.load, { sid: branch.sid, turn: target.turn, steps: nthIn(branch, target.turn, target.stepNo) }],
  };
}

/** The offsets of the pages of a turn still to read so that its first `steps` steps are on screen. */
export function pagesToRead(loaded: number, steps: number, total: number): number[] {
  const want = Math.min(steps, total);
  const first = Math.floor(loaded / STEPS_PAGE) * STEPS_PAGE;
  return loaded >= want ? [] : Array.from({ length: Math.ceil((want - first) / STEPS_PAGE) }, (_, i) => first + i * STEPS_PAGE);
}

export type JumpKind = 'failed' | 'repeated' | 'compaction' | 'subagent';
export interface JumpTarget { key: string; sid: string; turn: number; stepNo: number }

/** Where a mark sits in the order of the tree: a sub-agent's marks follow the call that started it. */
function orderOf(tree: Tree, m: Pick<Mark, 'sid' | 'turn' | 'seq'>): number[] {
  const spawn = tree.spawns.get(m.sid);
  return [...(spawn ? orderOf(tree, spawn) : []), m.turn, m.seq];
}
const byOrder = (a: number[], b: number[]): number => {
  const i = a.findIndex((v, k) => v !== b[k]);
  return i < 0 ? a.length - b.length : a[i]! - (b[i] ?? -1);
};

/** What a Jump to button visits, in the order of the tree: steps, or the compactions themselves. */
export function jumpTargets(tree: Tree, kind: JumpKind): JumpTarget[] {
  const picked = tree.marks.filter((m) => (kind === 'compaction' ? m.kind === 'compaction'
    : m.kind === 'tool_call' && (kind === 'failed' ? m.failed : kind === 'repeated' ? m.repeated : m.child !== null)));
  const sorted = picked.map((m) => ({ m, order: orderOf(tree, m) })).sort((a, b) => byOrder(a.order, b.order));
  // Two failed calls of one step are one place to visit.
  const seen = new Set<string>();
  return sorted.flatMap(({ m }): JumpTarget[] => {
    const key = m.kind === 'compaction' ? cutKey(m.sid, m.seq) : stepKey(m.sid, m.parentSeq ?? m.seq);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, sid: m.sid, turn: m.turn, stepNo: m.step }];
  });
}

/** The target after the selected one, and back to the first at the end or from anywhere else. */
export function nextTarget(targets: readonly JumpTarget[], selected: string | null): JumpTarget | null {
  if (!targets.length) return null;
  const at = targets.findIndex((t) => t.key === selected);
  return targets[(at + 1) % targets.length]!;
}

/**
 * The key of the row that stands for a selection or a mark. A turn of a sub-agent has no row of
 * its own: its branch does, which is the step that started it, or a row under that step when the
 * step started several.
 */
export function rowKeyOf(tree: Tree, key: string): string {
  const sel = parseSel(key);
  const branch = sel?.kind === 'turn' ? tree.branches.get(sel.sid) : undefined;
  const spawn = branch && branch.parent !== null ? tree.spawns.get(branch.sid) : undefined;
  if (!branch || !spawn) return key;
  const shared = [...tree.spawns.values()].filter((m) => m.sid === spawn.sid && m.parentSeq === spawn.parentSeq).length > 1;
  return shared ? turnKey(branch.sid, branch.turns[0]?.no ?? 1) : stepKey(spawn.sid, spawn.parentSeq ?? spawn.seq);
}
