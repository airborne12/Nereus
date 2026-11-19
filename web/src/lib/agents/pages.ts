// The Sessions, Steps, Messages, Risks and Memories pages as data: their columns in display order,
// which are shown at first, how a cell and a condition on it are written, and what a row opens.

import type { Row, TableName } from '../../api/agents.ts';
import { num, plainLine, text } from './format.ts';
import { cutKey, stepKey, turnKey } from './select.ts';

/** How a column's values are written and compared. */
export type CellKind = 'time' | 'text' | 'enum' | 'number' | 'count' | 'tokens' | 'duration' | 'percent';

export interface ColumnDef {
  /** Column name in the API. */
  name: string;
  label: string;
  kind: CellKind;
  /** Shown before the viewer changes the Columns menu. */
  shown: boolean;
  /** Values offered when a condition is put on the column. */
  values?: readonly string[];
  /** The column takes the width the others leave. */
  fill?: boolean;
}

export interface PageDef {
  name: TableName;
  label: string;
  /** One row of the page, in the singular. */
  noun: string;
  /** What a row is, said once under the title. */
  unit: string;
  /** Placeholder of the search box: the text the search runs on. */
  search: string;
  defaultSort: string;
  columns: ColumnDef[];
  /** The time range the page opens on, when not the past 7 days. */
  defaultRange?: '1h' | '24h' | '7d' | '30d';
}

const col = (name: string, label: string, kind: CellKind, shown: boolean, values?: readonly string[]): ColumnDef =>
  ({ name, label, kind, shown, ...(values ? { values } : {}) });

const STATUS = ['ok', 'failed'] as const;

export const SESSIONS: PageDef = {
  name: 'sessions', label: 'Sessions', noun: 'session', defaultSort: 'last_event_at',
  unit: 'One row per session tree: a main session with its sub-agent sessions.',
  search: 'Search title, first input, last output',
  columns: [
    col('last_event_at', 'Last activity', 'time', true),
    col('title', 'Session', 'text', true),
    col('tool_errors', 'Errors', 'count', true),
    col('safety_risks', 'Risks', 'count', true),
    col('first_input', 'First input', 'text', true),
    col('last_output', 'Last output', 'text', true),
    col('turns', 'Turns', 'number', true),
    col('steps', 'Steps', 'number', true),
    col('tokens', 'Tokens', 'tokens', true),
    col('started_at', 'Started', 'time', false),
    col('active_us', 'Active time', 'duration', false),
    col('subagents', 'Sub-agents', 'count', false),
    col('compactions', 'Compactions', 'count', false),
    col('peak_ctx_tokens', 'Peak context', 'tokens', false),
    col('model', 'Model', 'enum', false),
    col('user_id', 'User', 'enum', false),
  ],
};

export const STEPS: PageDef = {
  name: 'steps', label: 'Steps', noun: 'step', defaultSort: 'ts',
  unit: 'One row per step: one model request and the tool calls it issued.',
  search: 'Search output and tool calls',
  columns: [
    col('ts', 'Time', 'time', true),
    col('title', 'Session', 'text', true),
    col('agent', 'Agent', 'enum', true),
    col('turn', 'Turn', 'number', true),
    col('step', 'Step', 'number', true),
    col('calls', 'Tool calls', 'text', true),
    col('status', 'Status', 'enum', true, STATUS),
    col('output', 'Output', 'text', true),
    col('ctx_tokens', 'Context', 'tokens', true),
    col('duration_us', 'Latency', 'duration', true),
    col('repeated_call', 'Repeated call', 'enum', false, ['still in context', 'no longer in context']),
    col('stop_reason', 'Stop reason', 'enum', false, ['tool_use', 'end_turn', 'max_tokens']),
    col('ctx_msgs', 'Context msgs', 'number', false),
    col('ctx_new', 'New', 'number', false),
    col('ctx_change', 'Context change', 'enum', false, ['fresh', 'append', 'truncate', 'compact']),
    col('cache_pct', 'Cache hit', 'percent', false),
    col('output_tokens', 'Output tokens', 'tokens', false),
    col('tool_us', 'Tool time', 'duration', false),
    col('retries', 'Retries', 'count', false),
    col('model', 'Model', 'enum', false),
  ],
};

export const MESSAGES: PageDef = {
  name: 'messages', label: 'Messages', noun: 'message', defaultSort: 'ts',
  unit: 'One row per message block: a text, a tool call, a tool result or a summary, each with its role.',
  search: 'Search message text',
  columns: [
    col('ts', 'Time', 'time', true),
    col('title', 'Session', 'text', true),
    col('agent', 'Agent', 'enum', true),
    col('turn', 'Turn', 'number', true),
    col('step', 'Step', 'number', true),
    col('msg_role', 'Role', 'enum', true, ['user', 'assistant', 'tool', 'system']),
    col('kind', 'Kind', 'enum', true, ['text', 'tool_use', 'tool_result', 'thinking', 'summary', 'attachment']),
    col('tool_name', 'Tool', 'enum', true),
    col('status', 'Status', 'enum', true, STATUS),
    { ...col('text', 'Text', 'text', true), fill: true },
    col('tokens', 'Tokens', 'tokens', true),
  ],
};

export const RISKS: PageDef = {
  name: 'risks', label: 'Risks', noun: 'risk', defaultSort: 'ts',
  unit: 'One row per safety risk: a place where a session broke a safety rule.',
  search: 'Search rules and what happened',
  columns: [
    col('ts', 'Time', 'time', true),
    col('title', 'Session', 'text', true),
    col('agent', 'Agent', 'enum', false),
    col('turn', 'Turn', 'number', true),
    col('judgment', 'Judgment', 'enum', true, ['none', 'breach', 'review', 'ok']),
    col('rule_name', 'Rule', 'enum', true),
    { ...col('what', 'What happened', 'text', true), fill: true },
    col('why', 'Why it counts', 'text', false),
  ],
};

export const MEMORIES: PageDef = {
  name: 'memories', label: 'Memories', noun: 'memory', defaultSort: 'updated_at', defaultRange: '30d',
  unit: 'One row per memory an agent keeps, at its latest version.',
  search: 'Search names, descriptions and contents',
  columns: [
    col('updated_at', 'Updated', 'time', true),
    col('agent', 'Agent', 'enum', true, ['claude-code', 'gemini-cli']),
    col('scope', 'Scope', 'text', true),
    { ...col('name', 'Memory', 'text', true), fill: true },
    col('kind', 'Kind', 'enum', true),
    col('still_valid', 'Still valid', 'enum', true, ['unjudged', 'unused', 'unrecorded']),
    col('source_session_id', 'Source session', 'text', true),
    col('description', 'Description', 'text', false),
    col('source_kind', 'Source', 'enum', false, ['recorded', 'inferred', 'none']),
    col('source_score', 'Share of words', 'number', false),
    col('format', 'Format', 'enum', false, ['claude-auto-memory', 'gemini-md']),
    col('captured_at', 'Captured', 'time', false),
  ],
};

export const PAGES: Record<TableName, PageDef> = { sessions: SESSIONS, steps: STEPS, messages: MESSAGES, risks: RISKS, memories: MEMORIES };
/** The pages of sessions, which a narrow page offers as its siblings. */
export const SESSION_PAGES: readonly PageDef[] = [SESSIONS, STEPS, MESSAGES, RISKS];

/** What keeps the rows of a page apart: a memory by its key, else a session with the row's number. */
export function rowKey(def: PageDef, row: Row): string {
  if (def.name === 'memories') return [row.agent, row.scope, row.name].map(text).join('\n');
  return `${text(row.session_id)}:${text(def.name === 'steps' ? row.seq : def.name === 'messages' ? row.msg_seq : '')}`;
}

export const columnOf = (def: PageDef, name: string): ColumnDef | undefined => def.columns.find((c) => c.name === name);

/** The names of the columns a page shows: the viewer's choice in the page's order, or the default. */
export function shownColumns(def: PageDef, chosen: readonly string[] | null): string[] {
  const names = def.columns.filter((c) => (chosen ? chosen.includes(c.name) : c.shown)).map((c) => c.name);
  return names.length ? names : def.columns.filter((c) => c.shown).map((c) => c.name);
}

/** A column whose values are numbers, set to the right. */
export const isNumeric = (kind: CellKind): boolean => kind !== 'time' && kind !== 'text' && kind !== 'enum';

/** What a session is called on a row: its title, else the start of its first input, else its id. */
export function sessionName(row: Row): string {
  return text(row.title).trim() || plainLine(text(row.first_input)).slice(0, 80) || text(row.session_id);
}

/** What a row opens: the tree of its session, and what is selected there (null: the first turn) or which risk is shown. */
export function openTarget(page: TableName, row: Row): { root: string; sel: string | null; risk?: string } {
  const sid = text(row.session_id);
  if (page === 'sessions') return { root: sid, sel: null };
  const root = text(row.root_id) || sid;
  if (page === 'risks') return { root, sel: null, risk: `${sid}:${text(row.rule)}:${num(row.first_seq)}` };
  if (page === 'steps') return { root, sel: stepKey(sid, num(row.seq)) };
  const kind = text(row.event_kind);
  // A block opens the step that produced it, a summary its compaction, a user message its turn.
  if ((kind === 'llm_call' || kind === 'tool_call') && row.step_seq !== null && row.step_seq !== undefined) return { root, sel: stepKey(sid, num(row.step_seq)) };
  if (kind === 'compaction') return { root, sel: cutKey(sid, num(row.event_seq)) };
  if (row.turn !== null && row.turn !== undefined) return { root, sel: turnKey(sid, num(row.turn)) };
  return { root, sel: null };
}

/** The address of a session page. */
export function sessionUrl(root: string, sel: string | null, marks: string | null = null, risk: string | null = null): string {
  const p = new URLSearchParams();
  if (sel) p.set('sel', sel);
  if (marks) p.set('marks', marks);
  if (risk) p.set('risk', risk);
  const qs = p.toString();
  return `/agents/sessions/${encodeURIComponent(root)}${qs ? `?${qs}` : ''}`;
}
