// The Judges pages as data (spec 8.7): the state of a judge page in the address, a draft of a new
// judge and how a field changes it, what the model read split into its parts, and words for
// verdicts, versions, steps and schedules.

import type { DraftBody, JudgeTemplate, Pick, Run, Verdict, View } from '../../api/judges.ts';

export const VIEWS: Record<View, string> = { first: 'First violation in each session', all: 'All verdicts', changed: 'Changed by a rerun' };
const VERDICTS: Record<Verdict, string> = { violates: 'Violates', ok: 'Does not violate', unsure: 'No verdict' };
export const verdictLabel = (v: string): string => VERDICTS[v as Verdict] ?? 'No verdict';

/** The tools a pick offers. */
export const TOOLS: [string, string][] = [['any', 'Any tool'], ['change', 'Edit or Write'], ['Bash', 'Bash'], ['Read', 'Read'], ['Edit', 'Edit'], ['Write', 'Write'], ['Grep', 'Grep']];
export const RESULTS: [Pick['status'], string][] = [['any', 'any'], ['ok', 'ok'], ['error', 'failed']];
/** The most steps before the judged one the model can read. */
export const MAX_BEFORE = 10;
/** Steps a try runs on. */
export const TRY = 5;

export interface StepRef { session_id: string; seq: number }
export interface JudgeState { view: View; row: StepRef | null }

export function parseJudgeState(search: string): JudgeState {
  const p = new URLSearchParams(search);
  const view = p.get('view');
  const row = /^(.+):(\d+)$/.exec(p.get('row') ?? '');
  return { view: view === 'all' || view === 'changed' ? view : 'first', row: row ? { session_id: row[1]!, seq: Number(row[2]) } : null };
}

export function serializeJudgeState(s: JudgeState): string {
  const p = new URLSearchParams();
  if (s.view !== 'first') p.set('view', s.view);
  if (s.row) p.set('row', `${s.row.session_id}:${s.row.seq}`);
  const q = p.toString();
  return q ? `?${q}` : '';
}

/** A judge being written: the template it started from (or `own`), and `n` kept for "the N steps before". */
export interface Draft { template: string; name: string; pick: Pick; reads: { kind: 'step' | 'before' | 'turn'; n: number }; criterion: string; model: string; runsOnNew: boolean }

export function draftFrom(key: string, templates: Record<string, JudgeTemplate>): Draft {
  const t = templates[key]!;
  return { template: key, name: t.name, pick: { ...t.pick }, reads: { kind: t.reads.kind, n: t.reads.kind === 'before' ? t.reads.n : 3 }, criterion: t.criterion, model: t.model, runsOnNew: true };
}

const clampN = (v: unknown): number => Math.min(MAX_BEFORE, Math.max(1, Math.trunc(Number(v)) || 1));

/** The draft after one field changed. A template replaces what it sets; editing its criterion makes the draft one's own. */
export function editDraft(d: Draft, field: string, value: string | boolean, templates: Record<string, JudgeTemplate>): Draft {
  if (field === 'template') return value === 'own' || !templates[String(value)] ? { ...d, template: 'own' } : draftFrom(String(value), templates);
  if (field === 'criterion') {
    const own = d.template !== 'own' && value !== templates[d.template]?.criterion;
    return { ...d, criterion: String(value), template: own ? 'own' : d.template };
  }
  if (field === 'tool' || field === 'has' || field === 'status') return { ...d, pick: { ...d.pick, [field]: String(value) } };
  if (field === 'reads') return { ...d, reads: { ...d.reads, kind: value as Draft['reads']['kind'] } };
  if (field === 'n') return { ...d, reads: { ...d.reads, n: clampN(value) } };
  if (field === 'runsOnNew') return { ...d, runsOnNew: value === true };
  return { ...d, [field]: String(value) };
}

/** What is sent for a draft. */
export function draftBody(d: Draft): DraftBody {
  const reads = d.reads.kind === 'before' ? { kind: 'before' as const, n: d.reads.n } : { kind: d.reads.kind };
  return { name: d.name, pick: d.pick, reads, criterion: d.criterion, model: d.model, runsOnNew: d.runsOnNew };
}

export const canRun = (d: Draft, steps: number): boolean => steps > 0 && d.name.trim() !== '' && d.criterion.trim() !== '';

/** The part of a draft a count of the picked steps answers: what is picked and what the model reads. */
export const countKey = (d: Draft): string => JSON.stringify({ pick: d.pick, reads: draftBody(d).reads });
/** The part of a draft a try answers: that of the count, the criterion and the model. */
export const tryKey = (d: Draft): string => JSON.stringify({ pick: d.pick, reads: draftBody(d).reads, criterion: d.criterion, model: d.model });

/** What the form says when the estimate of a run is over its budget; null when it is not. */
export function budgetNote(estimate: number, steps: number, budget: number): string | null {
  if (steps === 0 || estimate <= budget) return null;
  const n = Math.floor(budget / (estimate / steps));
  return `The run stops at its budget of ${budget.toLocaleString('en-US')} input tokens, after about ${n.toLocaleString('en-US')} of ${steps.toLocaleString('en-US')} steps; the judge's page then offers to judge the rest.`;
}

/** Why a member cannot use the actions that spend model tokens. */
export const ADMIN_ONLY = 'Only admins make, change and rerun judges, since they spend model tokens.';

/** What the model read, as its parts: the request of the turn, how many steps were left out, and the steps. */
export interface ReadParts { request: string | null; omitted: number; steps: { judged: boolean; lines: string[] }[] }

/** The record's text as it was said: the record escapes it so that it cannot open or close a tag. */
const unescape = (text: string): string => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

export function parseRecord(text: string): ReadParts {
  const request = /<request>\n([\s\S]*?)\n<\/request>/.exec(text);
  const omitted = /<omitted steps="(\d+)"\/>/.exec(text);
  const steps = [...text.matchAll(/<step( judged="true")?>\n([\s\S]*?)\n<\/step>/g)].map((m) => ({ judged: m[1] !== undefined, lines: m[2]!.split('\n').map(unescape) }));
  return { request: request ? unescape(request[1]!) : null, omitted: omitted ? Number(omitted[1]) : 0, steps };
}

/** Whether the last run stopped or failed before it had judged the steps it was to judge first. */
export const leftOver = (run: { scope: Run['scope']; status: Run['status'] } | undefined): boolean =>
  run !== undefined && (run.scope === 'picked' || run.scope === 'new') && (run.status === 'stopped' || run.status === 'failed');

/** What changed from one version to the next. */
export function versionChange(prev: { criterion: string; model: string }, next: { criterion: string; model: string }): string {
  return [...(prev.criterion !== next.criterion ? ['criterion'] : []), ...(prev.model !== next.model ? [`model ${prev.model} → ${next.model}`] : [])].join(', ');
}

/** A judged step in a row: its number and its calls, or "reply" for a step that called nothing. */
export const stepText = (r: { step: number; calls: string | null }): string => `step ${r.step} · ${r.calls || 'reply'}`;

export const runsOnText = (runsOnNew: boolean): string => (runsOnNew ? 'new sessions too' : 'once');
