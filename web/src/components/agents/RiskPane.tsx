import { Fragment } from 'react';
import type { Risk, RuleInfo } from '../../api/agents.ts';
import { stamp, timeOf } from '../../lib/agents/format.ts';
import { eventKey, judgmentLabel, rulePicture } from '../../lib/agents/risks.ts';

/** A rule drawn as a row of pills: what must come first, or the order that is not allowed. */
function RulePicture({ rule }: { rule: RuleInfo }) {
  const p = rulePicture(rule);
  return (
    <div className="ag-rpic">
      <span className={`ag-rlabel ${p.tone}`}>{p.label}</span>
      {p.parts.map((part, i) => ('arrow' in part
        ? <span className="ag-rarrow" key={i}>{part.arrow}</span>
        : <span className={`ag-rstep ${part.tone}`} key={i}>{part.pill}</span>))}
    </div>
  );
}

interface Props {
  risk: Risk;
  /** The place of the risk among the risks of the tree, from 0, and how many there are. */
  at: number;
  total: number;
  /** The rule that found it, when the page knows it. */
  rule: RuleInfo | undefined;
  /** The name of the sub-agent the risk happened in; empty in the main session. */
  agent: string;
  onShow: (at: number) => void;
  /** Opens the row of an event, which leaves the view of the risk. */
  onOpen: (key: string) => void;
}

/**
 * A safety risk of the session: the judgment first, then the events that broke the rule, each
 * opening its step, then the rule drawn.
 */
export function RiskPane({ risk, at, total, rule, agent, onShow, onOpen }: Props) {
  const ms = timeOf(risk.ts);
  return (
    <div className="ag-pane ag-risk">
      <p className="ag-crumbs">
        Safety risk {at + 1} of {total}
        {total > 1 && (
          <span className="ag-rnav">
            <button type="button" onClick={() => onShow((at + total - 1) % total)}>‹ Previous</button>
            <button type="button" onClick={() => onShow((at + 1) % total)}>Next ›</button>
          </span>
        )}
      </p>
      <h2>{risk.rule_name}</h2>
      <p className="ag-pmeta">{ms === null ? '' : stamp(ms)}{agent ? ` · in ${agent}` : ''} · turn {risk.turn}</p>
      <div className="ag-judge none">
        <b className="ag-verdict">{judgmentLabel('none')}</b>
        <p>The rule found this risk; no model has read it yet.</p>
      </div>
      <section className="ag-io" aria-label="What happened">
        <h3><b>What happened</b><span>{risk.why}</span></h3>
        <div className="ag-revs">
          {risk.steps.map((s, i) => (
            <Fragment key={s.seq}>
              {i > 0 && <i className="ag-rsep">↓</i>}
              <button type="button" className="ag-rev" title="Open this step" onClick={() => onOpen(eventKey(risk.session_id, s))}>
                <span className="ag-sn">{s.kind === 'user' ? `T${s.turn}` : s.step}</span>{' '}<code>{s.what}</code>{' '}{s.target}
                {s.status === 'error' && <>{' '}<b className="bad">failed</b></>}
              </button>
            </Fragment>
          ))}
        </div>
      </section>
      {rule && (
        <section className="ag-io" aria-label="The rule">
          <h3><b>The rule</b><span>{rule.source}</span></h3>
          <RulePicture rule={rule} />
        </section>
      )}
    </div>
  );
}
