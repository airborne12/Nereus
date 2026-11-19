import type { ReactNode } from 'react';
import { parseRecord, verdictLabel } from '../../lib/agents/judges.ts';

/** One stage of a judge's plan: its number, what it does, and where it runs. */
export function Stage({ no, where, title, children }: { no: number; where: 'doris' | 'model'; title: string; children: ReactNode }) {
  return (
    <li className="jg-stage">
      <span className="jg-no">{no}</span>
      <div>
        <h3>{title}<span className={`jg-where ${where}`}>{where === 'model' ? 'Model, called by Nereus' : 'SQL in Doris'}</span></h3>
        {children}
      </div>
    </li>
  );
}

export function VerdictTag({ verdict }: { verdict: string }) {
  return <span className={`jg-verdict ${verdict}`}>{verdictLabel(verdict)}</span>;
}

/** What the model read for a step: the user's request of the turn, then the steps, the judged one marked. */
export function ReadRecord({ text }: { text: string }) {
  const r = parseRecord(text);
  return (
    <div className="jg-record">
      {r.request !== null && <p className="jg-asked"><b>Asked in this turn</b>{r.request}</p>}
      {r.omitted > 0 && <p className="muted">{r.omitted} earlier step{r.omitted === 1 ? '' : 's'} left out</p>}
      <ol>
        {r.steps.map((s, i) => (
          <li key={i} className={s.judged ? 'judged' : ''}>
            {s.judged && <span className="jg-mark">judged</span>}
            {s.lines.map((line, j) => <code key={j}>{line}</code>)}
          </li>
        ))}
      </ol>
    </div>
  );
}
