// The drawing of "what happens next" (spec 8.5): where each event of the tree sits and how the
// lines between them run. Columns are the starting event and the events after it; a line is as
// thick as its path is common.

import type { Other, PathNode, PathTree } from '../../api/sequences.ts';
import { nodeOf, patternOfPath, startLabel, type Step } from './sequences.ts';

export const ROW = 34;
export const COL = 230;
export const PADX = 14;
export const BOX = 128;
/** Columns of the drawing. */
const COLUMNS = 4;
/** Characters of a name that fit a pill beside its share. */
const LABEL_CHARS = 13;
const THICKEST = 22;

export interface DrawNode {
  x: number;
  y: number;
  label: string;
  /** The whole name, for a label that was clipped. */
  title: string;
  /** How often the start occurs, or the share of the runs that pass here. */
  count: string;
  tone: '' | 'bad' | 'ev';
  /** A node that opens nothing: the end of a session, or the rare branches drawn as one. */
  dim: boolean;
  /** The pattern that finds this path again. */
  pattern: Step[] | null;
}
export interface DrawLink { d: string; width: number; bad: boolean }
export interface Drawing { width: number; height: number; nodes: DrawNode[]; links: DrawLink[] }

/** A node as it is laid out: its row, and the nodes drawn to its right. */
interface Placed { node: DrawNode; times: number; kids: Placed[] }

const clip = (s: string): string => (s.length > LABEL_CHARS + 1 ? `${s.slice(0, LABEL_CHARS)}…` : s);

export function drawPaths(tree: PathTree, start: string): Drawing {
  if (!tree.total) return { width: 0, height: 0, nodes: [], links: [] };
  // A branch that is drawn occurs at least once, so its share never reads as none.
  const share = (times: number): string => `${Math.round((100 * times) / tree.total) || '<1'}%`;
  // Leaves take the rows from the top; a node sits between its first and last branch.
  let leaves = 0;
  const place = (level: number, kids: readonly PathNode[], other: Other | null, path: readonly string[], make: (y: number) => DrawNode, times: number): Placed => {
    const below: Placed[] = [
      ...kids.map((k) => {
        const n = nodeOf(k.key);
        const mine = [...path, k.key];
        return place(level + 1, k.kids, k.other, mine, (y) => ({
          x: PADX + (level + 1) * COL, y, label: clip(n.label), title: n.label, count: share(k.times),
          tone: n.failed ? 'bad' : n.kind === 'call' || n.kind === 'end' ? '' : 'ev', dim: n.kind === 'end', pattern: n.kind === 'end' ? null : patternOfPath(start, mine),
        }), k.times);
      }),
      ...(other ? [place(level + 1, [], null, path, (y) => ({
        x: PADX + (level + 1) * COL, y, label: `${other.count} other`, title: `${other.count} other`, count: share(other.times), tone: '', dim: true, pattern: null,
      }), other.times)] : []),
    ];
    const y = below.length ? (below[0]!.node.y + below[below.length - 1]!.node.y) / 2 : (leaves += 1) * ROW - ROW / 2;
    return { node: make(y), times, kids: below };
  };
  const root = place(0, tree.kids, tree.other, [], (y) => ({
    x: PADX, y, label: clip(startLabel(start)), title: startLabel(start), count: tree.total.toLocaleString('en-US'),
    tone: start === 'failed' ? 'bad' : start === 'user' ? 'ev' : '', dim: false, pattern: patternOfPath(start, []),
  }), tree.total);

  const nodes: DrawNode[] = [];
  const links: DrawLink[] = [];
  const walk = (p: Placed): void => {
    nodes.push(p.node);
    for (const k of p.kids) {
      const x1 = p.node.x + BOX;
      const mid = (x1 + k.node.x) / 2;
      links.push({
        d: `M${x1},${p.node.y}C${mid},${p.node.y} ${mid},${k.node.y} ${k.node.x},${k.node.y}`,
        width: Number(Math.max(1.5, (THICKEST * k.times) / tree.total).toFixed(1)), bad: k.node.tone === 'bad',
      });
      walk(k);
    }
  };
  walk(root);
  return { width: PADX * 2 + (COLUMNS - 1) * COL + BOX, height: leaves * ROW, nodes, links };
}
