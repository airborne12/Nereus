// AST of the search bar language (a Lucene query_string subset, close to Doris search() DSL).

/** A piece of a term: literal text, or an unescaped wildcard. */
export type Segment = { lit: string } | { any: '*' | '?' };

export type Node =
  | { kind: 'and'; left: Node; right: Node }
  | { kind: 'or'; left: Node; right: Node }
  | { kind: 'not'; child: Node }
  /** field null = the source's default text fields. */
  | { kind: 'term'; field: string | null; segments: Segment[] }
  | { kind: 'phrase'; field: string | null; text: string }
  | { kind: 'regex'; field: string | null; pattern: string }
  /** A bound of null is open. `>x` is a range with lo = x, loInclusive = false. */
  | {
      kind: 'range';
      field: string;
      lo: string | null;
      hi: string | null;
      loInclusive: boolean;
      hiInclusive: boolean;
    }
  /** `field:*` */
  | { kind: 'exists'; field: string };

export class QuerySyntaxError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} at position ${position}`);
    this.name = 'QuerySyntaxError';
    this.position = position;
  }
}

export function isWildcard(segments: Segment[]): boolean {
  return segments.some((s) => 'any' in s);
}

export function literalText(segments: Segment[]): string {
  return segments.map((s) => ('lit' in s ? s.lit : s.any)).join('');
}
