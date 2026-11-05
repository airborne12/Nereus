// Layout for the service map: services in columns by call depth (callers left of callees),
// ordered inside a column to keep edges short.

export interface Edge { src: string; dst: string }

export function layers(nodes: string[], edges: Edge[]): string[][] {
  const incoming = new Map(nodes.map((n) => [n, 0]));
  for (const e of edges) incoming.set(e.dst, (incoming.get(e.dst) ?? 0) + 1);
  const depth = new Map<string, number>();
  // Longest path from a root (no callers); a cycle falls back to the first visit.
  const roots = nodes.filter((n) => (incoming.get(n) ?? 0) === 0);
  const queue = (roots.length ? roots : nodes.slice(0, 1)).map((n) => [n, 0] as [string, number]);
  let guard = 0;
  while (queue.length && guard++ < 10_000) {
    const [n, d] = queue.shift()!;
    if ((depth.get(n) ?? -1) >= d) continue;
    depth.set(n, d);
    for (const e of edges) if (e.src === n && d + 1 < nodes.length) queue.push([e.dst, d + 1]);
  }
  for (const n of nodes) if (!depth.has(n)) depth.set(n, 0);
  const cols: string[][] = [];
  for (const [n, d] of depth) (cols[d] ??= []).push(n);
  // Order each column by the mean position of its callers in the previous column.
  for (let c = 1; c < cols.length; c++) {
    const prev = cols[c - 1] ?? [];
    const score = (n: string) => {
      const ps = edges.filter((e) => e.dst === n).map((e) => prev.indexOf(e.src)).filter((i) => i >= 0);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
    };
    cols[c] = (cols[c] ?? []).sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  }
  return cols.filter(Boolean);
}
