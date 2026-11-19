// Safety risks on the pages as data (spec 8.2, 8.3, 8.6): which risk an address names, the rows a
// risk marks on the lanes, a judgment in words, and a rule as a row of pills.

import type { Risk, RiskStep, RuleInfo, RuleStep } from '../../api/agents.ts';
import { plural, text } from './format.ts';
import { cutKey, type Mark, stepKey, turnKey } from './select.ts';

const JUDGMENT: Record<string, string> = { breach: 'Breach', review: 'Needs review', ok: 'Not a breach', none: 'Not judged yet' };

/** A judgment in words. Until a model has read a risk, it is not judged. */
export const judgmentLabel = (verdict: unknown): string => JUDGMENT[text(verdict)] ?? JUDGMENT.none!;

/** What the pane of a risk says of its judgment; `asked` is the question of the rule's judge when the page has it. */
export interface JudgmentBox { tone: Risk['judgment']; label: string; reason: string; asked: string | null; read: string | null }

/** The judgment of a risk as its pane shows it: the verdict and why, the question asked, and what the model read. */
export function judgmentBox(risk: Risk, rule: RuleInfo | undefined): JudgmentBox {
  const tone = risk.judgment in JUDGMENT ? risk.judgment : 'none';
  const asked = rule?.criterion ?? null;
  if (tone === 'none') return { tone, label: JUDGMENT.none!, reason: 'The rule found this risk; no model has read it yet.', asked, read: null };
  const read = `Read ${plural(Number(risk.read_events ?? 0), 'event')} with ${risk.judgment_model ?? 'the model'}, judge version ${risk.judge_version ?? 1}`;
  return { tone, label: JUDGMENT[tone]!, reason: risk.judgment_reason || 'The model gave no reason.', asked, read };
}

/** A risk as the address names it. */
export const riskKey = (r: Pick<Risk, 'session_id' | 'rule' | 'first_seq'>): string => `${r.session_id}:${r.rule}:${Number(r.first_seq)}`;

/** The place of the risk an address names among the risks of a tree: by its key, or `first`; -1 when it names none. */
export function riskAt(risks: readonly Risk[], param: string | null): number {
  if (param === null || risks.length === 0) return -1;
  return param === 'first' ? 0 : risks.findIndex((r) => riskKey(r) === param);
}

/** The row an event of a risk opens: the turn of an input, the model call of a tool call or a reply, a compaction. */
export function eventKey(sid: string, s: RiskStep): string {
  if (s.kind === 'user') return turnKey(sid, s.turn);
  if (s.kind === 'compaction') return cutKey(sid, s.seq);
  return stepKey(sid, s.kind === 'call' ? s.call ?? s.seq : s.seq);
}

/** The rows a risk marks on the lanes, with where each sits. */
export function riskMarks(risk: Risk): Mark[] {
  return risk.steps.map((s) => ({ key: eventKey(risk.session_id, s), sid: risk.session_id, turn: s.turn, stepNo: s.kind === 'user' ? null : s.step }));
}

/** The row a risk is shown at: that of the event it is keyed by, else of its first event; null without events. */
export function riskRowKey(risk: Risk): string | null {
  const step = risk.steps.find((s) => s.seq === Number(risk.first_seq)) ?? risk.steps[0];
  return step ? eventKey(risk.session_id, step) : null;
}

const KIND = { call: 'Any tool', user: 'User input', reply: 'Reply', compaction: 'Compaction' } as const;
const quoted = (words: readonly string[]): string => words.map((w) => `"${w.trim()}"`).join(' or ');

/** A step of a rule in words: `Bash failed · "test"`, `Read · ".env" or "secret"`. */
export function stepSaid(s: RuleStep): string {
  const what = `${s.kind === 'call' ? s.tool ?? KIND.call : KIND[s.kind]}${s.status ? ` ${s.status}` : ''}`;
  return [what, ...(s.has ? [`"${s.has}"`] : []), ...(s.any?.length ? [quoted(s.any)] : []), ...(s.words?.length ? [quoted(s.words)] : [])].join(' · ');
}

export type PicturePart = { pill: string; tone: 'ok' | 'pre' | 'act' } | { arrow: string };
export interface RulePicture { label: string; tone: 'ok' | 'bad'; parts: PicturePart[] }

const quotedList = (words: readonly string[] = []): string => words.map((w) => `"${w}"`).join(', ');

/** A rule drawn as a row of steps: what must come first, or the order that is not allowed, the last step being the act. */
export function rulePicture(rule: RuleInfo): RulePicture {
  if (rule.kind === 'confirm') {
    return {
      label: 'Must come first', tone: 'ok',
      parts: [
        { pill: 'Assistant asks (reply has "?")', tone: 'ok' }, { arrow: '→ next' },
        { pill: `User confirms (opens with ${quotedList(rule.confirm)}; none of ${quotedList(rule.refuse)})`, tone: 'ok' }, { arrow: '⇢ later, no other user input between' },
        { pill: stepSaid(rule.steps[0]!), tone: 'act' },
      ],
    };
  }
  return {
    label: rule.kind === 'deny' ? 'Not allowed' : 'Not allowed in this order', tone: 'bad',
    parts: rule.steps.flatMap((s, i): PicturePart[] => [
      ...(i > 0 ? [{ arrow: s.link === 'later' ? '⇢ later' : '→ next' }] : []),
      { pill: stepSaid(s), tone: i === rule.steps.length - 1 ? 'act' : 'pre' },
    ]),
  };
}
