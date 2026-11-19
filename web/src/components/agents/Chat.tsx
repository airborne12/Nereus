import { type ReactNode, useState } from 'react';
import { type Block, bubbles, callLine, callOf, clamp, groups, type Speaker } from '../../lib/agents/chat.ts';
import { clock, duration } from '../../lib/agents/format.ts';

const NAME: Record<Speaker, string> = { user: 'User', assistant: 'Assistant', tool: 'Tool', agent: 'Sub-agent', system: 'System', summary: 'Summary', attachment: 'Attachment' };

const icon = (shape: ReactNode) => <svg viewBox="0 0 16 16" aria-hidden="true">{shape}</svg>;
const ICON: Record<'user' | 'assistant' | 'tool' | 'agent', ReactNode> = {
  user: icon(<><circle cx="8" cy="5.6" r="2.5" /><path d="M3.2 13c.5-2.3 2.4-3.6 4.8-3.6s4.3 1.3 4.8 3.6" /></>),
  assistant: icon(<path d="M8 1.6c.5 3.3 1.8 5.4 6.4 6.4-4.6 1-5.9 3.1-6.4 6.4-.5-3.3-1.8-5.4-6.4-6.4 4.6-1 5.9-3.1 6.4-6.4z" />),
  tool: icon(<path d="M3.4 4.8l3.2 3.2-3.2 3.2M8.6 11.4h4" />),
  agent: icon(<><circle cx="4.5" cy="3.6" r="1.5" /><circle cx="4.5" cy="12.4" r="1.5" /><circle cx="11.5" cy="8" r="1.5" /><path d="M4.5 5.1v5.8M4.5 8H10" /></>),
};

/** A text that may be long: its start, and the rest on request. */
export function LongText({ block, as = 'p' }: { block: Block; as?: 'p' | 'pre' }) {
  const [open, setOpen] = useState(false);
  const { shown, hidden } = clamp(block.text, open);
  const Tag = as;
  return (
    <>
      <Tag>{shown}{hidden > 0 ? '…' : ''}</Tag>
      {hidden > 0 && <button type="button" className="ag-tmore" onClick={() => setOpen(true)}>Show all {block.text.length.toLocaleString('en-US')} characters</button>}
      {block.chars > block.text.length && (open || hidden === 0) && (
        <p className="ag-foot">The page holds the first {block.text.length.toLocaleString('en-US')} of {block.chars.toLocaleString('en-US')} characters.</p>
      )}
    </>
  );
}

/** One speaker's turn to talk: the avatar, the name, the time, and the bubbles. */
function Said({ who, detail, ts, children }: { who: 'user' | 'assistant' | 'tool' | 'agent'; detail?: string; ts: number | null; children: ReactNode }) {
  return (
    <div className={`ag-msg ${who}${who === 'assistant' ? '' : ' right'}`}>
      <span className="ag-av">{ICON[who]}</span>
      <div className="ag-says">
        <div className="ag-by"><span><b>{NAME[who]}</b>{detail ? ` ${detail}` : ''}</span>{ts !== null && <time>{clock(ts)}</time>}</div>
        {children}
      </div>
    </div>
  );
}

/** An injected attachment: one line, and the whole of it on request. */
function Attachment({ block }: { block: Block }) {
  const [open, setOpen] = useState(false);
  const line = block.text.replace(/\s+/g, ' ').trim();
  if (!open) {
    return (
      <div className="ag-notice">
        <b className="ag-tag">Attachment</b>{line.slice(0, 110)}{line.length > 110 ? '…' : ''}
        <button type="button" className="ag-tmore" onClick={() => setOpen(true)}>Show</button>
      </div>
    );
  }
  return (
    <div className="ag-sumcard">
      <b>Attachment <button type="button" className="ag-tmore" onClick={() => setOpen(false)}>Hide</button></b>
      <LongText block={block} as="pre" />
    </div>
  );
}

interface Props {
  blocks: readonly Block[];
  /** Blocks in which the call of a tool result may be found; by default the thread's own. */
  around?: readonly Block[];
  /** What the page knows about one answer, shown under it. */
  extra?: (b: Block) => ReactNode;
  /** The name of the sub-agent that gave an answer, where the page knows it. */
  agentName?: (b: Block) => string | undefined;
}

/** Messages as a chat: the assistant on the left, whoever it talks with on the right, notices in the middle. */
export function Thread({ blocks, around, extra, agentName }: Props) {
  const all = around ?? blocks;
  return (
    <>
      {groups(blocks).map((g) => {
        const first = g.parts[0]!;
        const key = `${g.who}:${first.seq}`;
        if (g.who === 'system') return g.parts.map((b) => <div className="ag-notice" key={b.seq}><b className="ag-tag">System</b>{b.text.slice(0, 200)}</div>);
        if (g.who === 'summary') return <div className="ag-sumcard" key={key}><b>Summary</b><LongText block={first} /></div>;
        if (g.who === 'attachment') return <Attachment key={key} block={first} />;
        if (g.who === 'user') {
          return <Said key={key} who="user" ts={first.ts}>{g.parts.map((b) => <div className="ag-bub" key={b.seq}><LongText block={b} /></div>)}</Said>;
        }
        if (g.who === 'assistant') {
          return (
            <Said key={key} who="assistant" ts={first.ts}>
              {bubbles(g.parts).map((parts) => (
                <div className="ag-bub" key={parts[0]!.seq}>
                  {parts.map((b) => {
                    if (b.kind === 'tool_use') {
                      const c = callOf(b);
                      return <p className="ag-call" key={b.seq}><span>Tool call</span><code>{c.name}{c.args ? ` ${c.args}` : ''}</code></p>;
                    }
                    if (b.kind === 'thinking') return <p className="ag-think" key={b.seq}>{b.text}</p>;
                    return <LongText key={b.seq} block={b} />;
                  })}
                </div>
              ))}
            </Said>
          );
        }
        if (g.who === 'agent') {
          return <Said key={key} who="agent" detail={agentName?.(first) ?? callLine(first, all).replace(/^\S+\s*/, '')} ts={first.ts}><div className="ag-bub"><LongText block={first} />{extra?.(first)}</div></Said>;
        }
        return (
          <Said key={key} who="tool" ts={first.ts}>
            {g.parts.map((b) => (
              <div className={`ag-bub${b.failed ? ' bad' : ''}`} key={b.seq}>
                <p className="ag-sig">
                  <code>{callLine(b, all)}</code>
                  <span>{b.failed ? <b className="bad">failed</b> : 'ok'}{b.call ? ` · ${duration(b.call.durationUs)}` : ''}</span>
                </p>
                <LongText block={b} as="pre" />
                {extra?.(b)}
              </div>
            ))}
          </Said>
        );
      })}
    </>
  );
}

/** A part of the right side under a small heading: Input, Output, Tool results. */
export function Section({ title, note, children }: { title: string; note: ReactNode; children: ReactNode }) {
  return (
    <section className="ag-io" aria-label={title}>
      <h3><b>{title}</b><span>{note}</span></h3>
      <div className="ag-thread">{children}</div>
    </section>
  );
}
