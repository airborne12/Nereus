import { BOX, COL, type Drawing, PADX } from '../../lib/agents/path-draw.ts';
import type { Step } from '../../lib/agents/sequences.ts';

const HEADS = ['Starts with', 'Next', 'Then', 'Then'];
/** Room above the first row for the heads of the columns. */
const TOP = 24;

/**
 * "What happens next" as a drawing: a pill per event with its share, and a line to each event
 * that came next. A pill opens the pattern of its path.
 */
export function PathDrawing({ drawing, onOpen }: { drawing: Drawing; onOpen: (pattern: Step[]) => void }) {
  return (
    <svg className="ag-paths" width={drawing.width} height={drawing.height + TOP + 6} role="group" aria-label="What follows the chosen event">
      {HEADS.map((t, i) => <text key={i} className="ag-ph" x={PADX + i * COL + 12} y={14}>{t}</text>)}
      <g transform={`translate(0,${TOP})`}>
        {drawing.links.map((l, i) => <path key={i} className={`ag-pl${l.bad ? ' bad' : ''}`} strokeWidth={l.width} d={l.d} />)}
        {drawing.nodes.map((n, i) => {
          const pattern = n.pattern;
          const open = pattern ? () => onOpen(pattern) : undefined;
          return (
            <g key={i} className={`ag-pn${n.tone ? ` ${n.tone}` : ''}${n.dim ? ' dim' : ''}`} {...(open ? { tabIndex: 0, role: 'link', onClick: open } : {})}
              onKeyDown={(e) => { if (e.key === 'Enter') open?.(); }}>
              <title>{pattern ? `${n.title}: see where this path occurs` : n.title}</title>
              <rect x={n.x} y={n.y - 12} width={BOX} height={24} rx={12} />
              <text className="ag-pt" x={n.x + 12} y={n.y + 4}>{n.label}</text>
              <text className="ag-pc" x={n.x + BOX - 10} y={n.y + 4}>{n.count}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
