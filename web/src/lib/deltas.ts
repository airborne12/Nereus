// Event Deltas: compare a selection of spans with all of them, field by field.
import type * as api from '../api.ts';

export const BANDS_PER_DECADE = 4;
/** Lowest duration (µs) of a heatmap band; bands are 4 per power of ten, as the server computes them. */
export const bandLow = (b: number) => Math.round(10 ** (b / BANDS_PER_DECADE));

export interface Selection { from: number; to: number; bLo: number; bHi: number }

export interface Delta {
  field: string;
  values: { v: string; sel: number; bg: number }[];
  score: number;
}

/** Difference in share, to 0.1 per mille, so equal gaps tie instead of differing by rounding noise. */
const gap = (x: { sel: number; bg: number }) => Math.round(Math.abs(x.sel - x.bg) * 1e4);

/** Per field, the share of each value in the selection and in the background, biggest differences first. */
export function compareFacets(sel: { sampled: number; facets: api.Facet[] }, bg: { sampled: number; facets: api.Facet[] }): Delta[] {
  const out: Delta[] = [];
  for (const f of sel.facets) {
    const other = bg.facets.find((x) => x.field === f.field);
    const vals = new Set([...f.values.map((x) => x.v), ...(other?.values ?? []).map((x) => x.v)]);
    const values = [...vals].map((v) => ({
      v,
      sel: sel.sampled ? (f.values.find((x) => x.v === v)?.n ?? 0) / sel.sampled : 0,
      bg: bg.sampled ? (other?.values.find((x) => x.v === v)?.n ?? 0) / bg.sampled : 0,
    })).sort((a, b) => gap(b) - gap(a) || (b.sel - b.bg) - (a.sel - a.bg));
    if (values.length < 2 && values[0] && Math.abs(values[0].sel - values[0].bg) < 1e-9) continue;
    out.push({ field: f.field, values: values.slice(0, 6), score: Math.max(0, ...values.map((x) => Math.abs(x.sel - x.bg))) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The spec of a selection: the same search narrowed to its time span and duration band. */
export function selectionSpec(spec: api.Spec, s: Selection): api.Spec {
  const lo = bandLow(s.bLo), hi = bandLow(s.bHi + 1);
  const where = spec.language === 'sql'
    ? `${spec.where.trim() ? `(${spec.where}) AND ` : ''}duration >= ${lo} AND duration < ${hi}`
    : `${spec.where.trim() ? `(${spec.where}) ` : ''}duration:[${lo} TO ${hi}}`;
  return { ...spec, where, range: { from: s.from, to: s.to } };
}

