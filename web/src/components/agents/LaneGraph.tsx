import { bandPath, half, HEIGHT, laneX, NODE_Y, type RowKind } from '../../lib/agents/lane-draw.ts';

interface Props {
  kind: RowKind;
  lane: number;
  /** Context size at the top edge, at the node and at the bottom edge of the row. */
  from: number;
  at: number;
  to: number;
  above: boolean;
  below: boolean;
  /** For each lane to the left: the context size of the lane passing through, or null. */
  pass: (number | null)[];
  /** Tokens of the widest lane. */
  scale: number;
  /** What sits on the lane: a numbered turn, a step dot, the bud where a sub-agent's lane begins, or nothing. */
  node: { turn: number; selected: boolean } | { dot: string } | { bud: true } | null;
  /** A sub-agent branch leaving the node: open with the width of its lane, or closed as a bud. */
  branch?: { open: boolean; width: number } | null;
  /** The row has no lane of its own; only the lanes that pass by are drawn. */
  empty?: boolean;
}

/** The drawing at the left of one row: lanes that pass by, the row's own lane, a branch, the node. */
export function LaneGraph({ kind, lane, from, at, to, above, below, pass, scale, node, branch, empty }: Props) {
  const h = HEIGHT[kind];
  const cy = NODE_Y[kind];
  const cx = laneX(lane);
  const nx = laneX(lane + 1);
  const band = empty ? null : bandPath({ kind, lane, from, at, to, above, below }, scale);
  return (
    <svg className="ag-rg" width={nx + 6} height={h} aria-hidden="true">
      {pass.map((tok, i) => (tok === null ? null : <rect key={i} className="ag-rl" x={laneX(i) - half(tok, scale)} y={0} width={2 * half(tok, scale)} height={h} />))}
      {band && <path className="ag-rl" d={band} />}
      {!empty && kind === 'more' && <line className="ag-hid" x1={cx} y1={0} x2={cx} y2={h} strokeWidth={Math.max(2, 2 * half(from, scale))} />}
      {branch?.open && <path className="ag-br" strokeWidth={branch.width} d={`M${cx},${cy}H${nx - 9}Q${nx},${cy} ${nx},${cy + 9}V${h}`} />}
      {branch && !branch.open && (
        <>
          <path className="ag-br" strokeWidth={2} d={`M${cx},${cy}H${nx - 4}`} />
          <circle className="ag-bud" cx={nx} cy={cy} r={3} />
        </>
      )}
      {node && 'turn' in node && (
        <>
          <circle className={`ag-stop${node.selected ? ' on' : ''}`} cx={cx} cy={cy} r={9} />
          <text className={`ag-no${node.selected ? ' on' : ''}`} x={cx} y={cy + 3.5}>{node.turn}</text>
        </>
      )}
      {node && 'dot' in node && <circle className={`ag-dot${node.dot ? ` ${node.dot}` : ''}`} cx={cx} cy={cy} r={3.5} />}
      {node && 'bud' in node && (
        <>
          <path className="ag-br" strokeWidth={2} d={`M${laneX(lane - 1)},${cy}H${cx - 4}`} />
          <circle className="ag-bud" cx={cx} cy={cy} r={3.5} />
        </>
      )}
    </svg>
  );
}
