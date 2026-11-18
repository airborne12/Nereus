import { type ReactNode, useState } from 'react';
import type * as api from '../../api/agents.ts';
import { type Block, blockOf, inputView } from '../../lib/agents/chat.ts';
import { duration, fileSize, num, plural, stamp, text, timeOf, tokens } from '../../lib/agents/format.ts';
import type { Branch, Turn } from '../../lib/agents/lanes.ts';
import { Section, Thread } from './Chat.tsx';

/** Folded messages open this many at a time. */
const PAGE = 100;

/** A selected turn: the user's input and the answer the turn ended with. Its steps stay on the left. */
export function TurnPane({ turn, answer, inner, open, onTwist }: { turn: Turn | undefined; answer: api.TurnAnswer; inner: boolean; open: boolean; onTwist: (() => void) | null }) {
  const blocks = answer.blocks.map(blockOf);
  const asked = blocks.filter((b) => b.role !== 'assistant');
  const answered = blocks.filter((b) => b.role === 'assistant');
  return (
    <>
      {turn && <p className="ag-pmeta">{turn.startedAt === null ? '' : `${stamp(turn.startedAt)} · `}{duration(turn.activeUs)} active</p>}
      <Section title="Input" note={inner ? 'what the sub-agent was asked' : 'what the user asked'}>
        {asked.length ? <Thread blocks={asked} /> : <div className="ag-notice">This turn has no user input.</div>}
      </Section>
      <Section title="Output" note={inner ? 'what the sub-agent returned' : 'what the assistant answered'}>
        {turn && (
          <div className="ag-notice">
            {plural(turn.steps, 'step')}{turn.failedCalls > 0 && <> · <b className="bad">{turn.failedCalls} failed</b></>}
            {turn.compactions > 0 && <> · {plural(turn.compactions, 'compaction')}</>}
            {onTwist && turn.steps > 0 && <button type="button" className="ag-tmore" onClick={onTwist}>{open ? 'Hide its steps' : 'Show its steps'}</button>}
          </div>
        )}
        {answered.length ? <Thread blocks={answered} /> : <div className="ag-notice">The turn ended without an answer in words.</div>}
      </Section>
    </>
  );
}

interface StepProps {
  answer: api.StepAnswer;
  /** Input blocks read after the first page, latest first. */
  older: api.Row[];
  onOlder: () => void;
  loadingOlder: boolean;
  /** The sub-agent branch a call of this step started, by the call's sequence number. */
  childOf: (callSeq: number) => Branch | null;
  isOpen: (b: Branch) => boolean;
  onTwist: (b: Branch) => void;
}

/** A selected step: the request as the model saw it, the message it answered with, and what its calls returned. */
export function StepPane({ answer, older, onOlder, loadingOlder, childOf, isOpen, onTwist }: StepProps) {
  const [earlier, setEarlier] = useState(false);
  const e = answer.step;
  const read = [...answer.input, ...older].map(blockOf);
  const view = inputView(read, answer.inputTotal, answer.inputNew);
  const output = answer.output.map(blockOf);
  const said = output.filter((b) => b.role === 'assistant');
  const results = output.filter((b) => b.role === 'tool');
  const toolUs = results.reduce((a, b) => a + (b.call?.durationUs ?? 0), 0);
  const ctx = num(e.input_tokens) + num(e.cache_read_tokens) + num(e.cache_write_tokens);
  const ts = timeOf(e.ts);
  // Older blocks are read when the earlier messages are open, or when not every new block is read yet.
  const showOlder = view.unread > 0 && (earlier || view.fresh.length < answer.inputNew);
  const extra = (b: Block): ReactNode => {
    const child = b.call ? childOf(b.call.seq) : null;
    if (child) {
      return (
        <>
          <p className="ag-foot">{child.model} · {plural(child.turns.reduce((n, t) => n + t.steps, 0), 'step')} · {duration(b.call!.durationUs)}</p>
          <button type="button" className="ag-tmore" onClick={() => onTwist(child)}>{isOpen(child) ? 'Hide its steps' : 'Show its steps'}</button>
        </>
      );
    }
    if (!b.call || b.call.repeatOf === null) return null;
    return <p className="ag-foot warn">The same call was made before. {b.call.repeatVisible ? 'That result was still in the context.' : 'That result was no longer in the context.'}</p>;
  };
  return (
    <>
      <p className="ag-pmeta">
        {ts === null ? '' : `${stamp(ts)} · `}model {duration(num(e.duration_us))}{toolUs > 0 ? ` · tools ${duration(toolUs)}` : ''} · {text(e.model)}
        {num(e.ctx_exact) === 1 ? '' : ' · context inferred: the source has no request log'}
      </p>
      <Section title="Input" note={`what the model saw · ${tokens(ctx)} tokens in ${plural(answer.inputTotal, 'message')}`}>
        {answer.prompt && (
          <div className="ag-notice"><b className="ag-tag">System</b>
            System prompt and {plural((answer.prompt.tool_names as unknown[] | null)?.length ?? 0, 'tool definition')} · {fileSize(num(answer.prompt.bytes))}
          </div>
        )}
        {e.ctx_change === 'compact' && <div className="ag-notice">The context was compacted before this step. A summary stands in for the earlier messages.</div>}
        {view.earlierTotal > 0 && (
          <button type="button" className="ag-fold" aria-expanded={earlier} onClick={() => setEarlier(!earlier)}>
            {earlier ? `Hide the ${plural(view.earlierTotal, 'earlier message')}` : `${plural(view.earlierTotal, 'earlier message')}, the same as in the previous request`}
          </button>
        )}
        {showOlder && (
          <button type="button" className="ag-fold more" disabled={loadingOlder} onClick={onOlder}>
            {loadingOlder ? 'Reading…' : `Show ${Math.min(PAGE, view.unread)} older of ${view.unread.toLocaleString('en-US')}`}
          </button>
        )}
        {earlier && <Thread blocks={view.earlier} around={read} />}
        {earlier && view.earlier.length > 0 && view.fresh.length > 0 && <div className="ag-mark">New in this request</div>}
        <Thread blocks={view.fresh} around={read} />
      </Section>
      <Section title="Output" note={`what the model answered · ${tokens(num(e.output_tokens))} tokens · ${duration(num(e.duration_us))}`}>
        {said.length ? <Thread blocks={said} /> : <div className="ag-notice">The model call returned nothing the page can show.</div>}
      </Section>
      {results.length > 0 && (
        <Section title="Tool results" note={`what the calls returned · ${duration(toolUs)}`}><Thread blocks={results} around={output} extra={extra} agentName={(b) => (b.call ? childOf(b.call.seq)?.name : undefined)} /></Section>
      )}
    </>
  );
}

/** A selected compaction: the messages it replaced and the summary that stands in for them. */
export function CutPane({ answer }: { answer: api.CompactionAnswer }) {
  const [shown, setShown] = useState(0);
  const gone = answer.replaced.map(blockOf);
  const summary = answer.summary.map(blockOf);
  const attrs = (answer.event.attrs ?? {}) as Record<string, unknown>;
  const ts = timeOf(answer.event.ts);
  const from = Math.max(0, gone.length - shown);
  return (
    <>
      <p className="ag-pmeta">{ts === null ? '' : `${stamp(ts)} · `}in turn {num(answer.event.turn)}{attrs.trigger ? ` · ${text(attrs.trigger)}` : ''}</p>
      <Section title="Replaced" note={`what the model saw before${attrs.pre_tokens ? ` · ${tokens(num(attrs.pre_tokens))} tokens` : ''}`}>
        {gone.length === 0 && <div className="ag-notice">No replaced messages are recorded for this compaction.</div>}
        {gone.length > 0 && (
          <button type="button" className="ag-fold" aria-expanded={shown > 0} onClick={() => setShown(shown > 0 ? 0 : PAGE)}>
            {shown > 0 ? `Hide the ${plural(gone.length, 'message')}` : `${plural(gone.length, 'message')} that later steps no longer see`}
          </button>
        )}
        {shown > 0 && from > 0 && (
          <button type="button" className="ag-fold more" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, from)} older of {from.toLocaleString('en-US')}</button>
        )}
        {shown > 0 && <Thread blocks={gone.slice(from)} around={gone} />}
      </Section>
      <Section title="Summary" note={`what later steps see instead${attrs.post_tokens ? ` · ${tokens(num(attrs.post_tokens))} tokens` : ''}`}>
        {summary.length ? <Thread blocks={summary} /> : <div className="ag-notice">No summary is recorded for this compaction.</div>}
      </Section>
    </>
  );
}
