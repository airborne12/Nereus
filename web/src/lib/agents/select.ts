// What is selected on the session page: a turn, a step (one model call) or a compaction of one
// branch. The key is what the address carries.

export type Selection =
  | { kind: 'turn'; sid: string; turn: number }
  | { kind: 'step'; sid: string; seq: number }
  | { kind: 'cut'; sid: string; seq: number };

const LETTER = { turn: 't', step: 's', cut: 'c' } as const;
const KIND = { t: 'turn', s: 'step', c: 'cut' } as const;

export const turnKey = (sid: string, turn: number): string => `t:${sid}:${turn}`;
export const stepKey = (sid: string, seq: number): string => `s:${sid}:${seq}`;
export const cutKey = (sid: string, seq: number): string => `c:${sid}:${seq}`;

export function selKey(s: Selection): string {
  return `${LETTER[s.kind]}:${s.sid}:${s.kind === 'turn' ? s.turn : s.seq}`;
}

/** A selection from its key; a session id may hold colons, so the number is what follows the last one. */
export function parseSel(key: string | null | undefined): Selection | null {
  const m = /^([tsc]):(.+):(\d+)$/.exec(key ?? '');
  if (!m) return null;
  const kind = KIND[m[1] as 't' | 's' | 'c'];
  const n = Number(m[3]);
  if (!Number.isSafeInteger(n)) return null;
  return kind === 'turn' ? { kind, sid: m[2]!, turn: n } : { kind, sid: m[2]!, seq: n };
}
