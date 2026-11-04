// Lexer and recursive-descent parser for the search bar language.
//
//   query    := or EOF | EOF                      (empty query = match everything)
//   or       := and (OR and)*
//   and      := unary ((AND)? unary)*            (adjacent terms are ANDed)
//   unary    := (NOT | '-') unary | primary
//   primary  := '(' or ')' | FIELD ':' fieldval | value
//   fieldval := value | '(' or-with-default-field ')' | RANGE | CMP value | '*'
//   value    := WORD | PHRASE | REGEX
//
// Words take backslash escapes; an unescaped * or ? in a word is a wildcard.

import { type Node, type Segment, QuerySyntaxError, isWildcard, literalText } from './ast.ts';

type Token =
  | { t: 'lparen' | 'rparen' | 'colon' | 'and' | 'or' | 'not' | 'minus' | 'eof'; pos: number }
  | { t: 'word'; segments: Segment[]; pos: number }
  | { t: 'phrase'; text: string; pos: number }
  | { t: 'regex'; pattern: string; pos: number }
  | { t: 'range'; lo: string | null; hi: string | null; loInc: boolean; hiInc: boolean; pos: number }
  | { t: 'cmp'; op: '>' | '>=' | '<' | '<='; pos: number };

const WORD_STOP = new Set([' ', '\t', '\n', '\r', '(', ')', ':', '"']);
const CMP_VALUE_STOP = new Set([' ', '\t', '\n', '\r', '(', ')', '"']);

function lex(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  // A token "starts a value" when it is at the very start or follows whitespace, '(' or ':'.
  const atValueStart = () => {
    const prev = out.at(-1);
    return prev === undefined || prev.t === 'lparen' || prev.t === 'colon' || /\s/.test(input[i - 1] ?? ' ');
  };
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const pos = i;
    if (c === '(') { out.push({ t: 'lparen', pos }); i++; continue; }
    if (c === ')') { out.push({ t: 'rparen', pos }); i++; continue; }
    if (c === ':') { out.push({ t: 'colon', pos }); i++; continue; }
    if (c === '-' && atValueStart() && out.at(-1)?.t !== 'colon') {
      out.push({ t: 'minus', pos });
      i++;
      continue;
    }
    if (c === '"') {
      let text = '';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        text += input[i]!;
        i++;
      }
      if (i >= input.length) throw new QuerySyntaxError('unterminated phrase', pos);
      i++;
      out.push({ t: 'phrase', text, pos });
      continue;
    }
    if (c === '/' && atValueStart()) {
      let pattern = '';
      i++;
      while (i < input.length && input[i] !== '/') {
        if (input[i] === '\\' && input[i + 1] === '/') {
          pattern += '/';
          i += 2;
          continue;
        }
        pattern += input[i]!;
        i++;
      }
      if (i >= input.length) throw new QuerySyntaxError('unterminated regular expression', pos);
      i++;
      out.push({ t: 'regex', pattern, pos });
      continue;
    }
    if ((c === '[' || c === '{') && out.at(-1)?.t === 'colon') {
      const close = input.slice(i + 1).search(/[\]}]/);
      if (close < 0) throw new QuerySyntaxError('unterminated range', pos);
      const end = i + 1 + close;
      const body = input.slice(i + 1, end).trim();
      const m = /^(\S+)\s+TO\s+(\S+)$/.exec(body);
      if (!m) throw new QuerySyntaxError('range must look like [a TO b]', pos);
      const bound = (s: string) => (s === '*' ? null : s);
      out.push({
        t: 'range', lo: bound(m[1]!), hi: bound(m[2]!),
        loInc: c === '[', hiInc: input[end] === ']', pos,
      });
      i = end + 1;
      continue;
    }
    if ((c === '>' || c === '<') && out.at(-1)?.t === 'colon') {
      const op = input[i + 1] === '=' ? (`${c}=` as '>=' | '<=') : c;
      out.push({ t: 'cmp', op, pos });
      i += op.length;
      continue;
    }
    // Word. After a comparison the value may contain ':' (times like 05:00:00).
    const stop = out.at(-1)?.t === 'cmp' ? CMP_VALUE_STOP : WORD_STOP;
    const segments: Segment[] = [];
    let lit = '';
    while (i < input.length && !stop.has(input[i]!)) {
      const ch = input[i]!;
      if (ch === '\\') {
        if (i + 1 >= input.length) throw new QuerySyntaxError('dangling escape', i);
        lit += input[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '*' || ch === '?') {
        if (lit) segments.push({ lit });
        lit = '';
        segments.push({ any: ch });
        i++;
        continue;
      }
      lit += ch;
      i++;
    }
    if (lit) segments.push({ lit });
    const plain = segments.length === 1 && 'lit' in segments[0]! ? segments[0].lit : null;
    if (plain === 'AND') out.push({ t: 'and', pos });
    else if (plain === 'OR') out.push({ t: 'or', pos });
    else if (plain === 'NOT') out.push({ t: 'not', pos });
    else out.push({ t: 'word', segments, pos });
  }
  out.push({ t: 'eof', pos: input.length });
  return out;
}

const FIELD_RE = /^[A-Za-z_@][A-Za-z0-9_.@-]*$/;

class Parser {
  private toks: Token[];
  private i = 0;
  constructor(toks: Token[]) {
    this.toks = toks;
  }
  private peek(k = 0): Token {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)]!;
  }
  private next(): Token {
    return this.toks[this.i++]!;
  }
  private expect(t: Token['t']): Token {
    const tok = this.next();
    if (tok.t !== t) throw new QuerySyntaxError(`expected ${t}, found ${tok.t}`, tok.pos);
    return tok;
  }

  parseQuery(): Node | null {
    if (this.peek().t === 'eof') return null;
    const n = this.parseOr(null);
    const tok = this.peek();
    if (tok.t !== 'eof') throw new QuerySyntaxError(`unexpected ${tok.t}`, tok.pos);
    return n;
  }

  private parseOr(field: string | null): Node {
    let left = this.parseAnd(field);
    while (this.peek().t === 'or') {
      this.next();
      left = { kind: 'or', left, right: this.parseAnd(field) };
    }
    return left;
  }

  private startsUnary(t: Token['t']): boolean {
    return ['not', 'minus', 'lparen', 'word', 'phrase', 'regex'].includes(t);
  }

  private parseAnd(field: string | null): Node {
    let left = this.parseUnary(field);
    for (;;) {
      if (this.peek().t === 'and') {
        this.next();
      } else if (!this.startsUnary(this.peek().t)) {
        return left;
      }
      left = { kind: 'and', left, right: this.parseUnary(field) };
    }
  }

  private parseUnary(field: string | null): Node {
    const t = this.peek().t;
    if (t === 'not' || t === 'minus') {
      this.next();
      return { kind: 'not', child: this.parseUnary(field) };
    }
    return this.parsePrimary(field);
  }

  private parsePrimary(field: string | null): Node {
    const tok = this.peek();
    if (tok.t === 'lparen') {
      this.next();
      const n = this.parseOr(field);
      this.expect('rparen');
      return n;
    }
    if (tok.t === 'word' && this.peek(1).t === 'colon') {
      if (field !== null) throw new QuerySyntaxError('nested field inside a field group', tok.pos);
      this.next();
      this.next();
      const name = literalText(tok.segments);
      if (isWildcard(tok.segments) || !FIELD_RE.test(name)) {
        throw new QuerySyntaxError(`invalid field name '${name}'`, tok.pos);
      }
      return this.parseFieldValue(name);
    }
    return this.parseValue(field);
  }

  private parseFieldValue(field: string): Node {
    const tok = this.peek();
    if (tok.t === 'lparen') {
      this.next();
      const n = this.parseOr(field);
      this.expect('rparen');
      return n;
    }
    if (tok.t === 'range') {
      this.next();
      return { kind: 'range', field, lo: tok.lo, hi: tok.hi, loInclusive: tok.loInc, hiInclusive: tok.hiInc };
    }
    if (tok.t === 'cmp') {
      this.next();
      const v = this.next();
      if (v.t !== 'word' || isWildcard(v.segments)) throw new QuerySyntaxError('expected a value after comparison', v.pos);
      const value = literalText(v.segments);
      return tok.op.startsWith('>')
        ? { kind: 'range', field, lo: value, hi: null, loInclusive: tok.op === '>=', hiInclusive: false }
        : { kind: 'range', field, lo: null, hi: value, loInclusive: false, hiInclusive: tok.op === '<=' };
    }
    if (tok.t === 'word' && tok.segments.length === 1 && 'any' in tok.segments[0]! && tok.segments[0].any === '*') {
      this.next();
      return { kind: 'exists', field };
    }
    return this.parseValue(field);
  }

  private parseValue(field: string | null): Node {
    const tok = this.next();
    if (tok.t === 'word') return { kind: 'term', field, segments: tok.segments };
    if (tok.t === 'phrase') return { kind: 'phrase', field, text: tok.text };
    if (tok.t === 'regex') return { kind: 'regex', field, pattern: tok.pattern };
    throw new QuerySyntaxError(`unexpected ${tok.t}`, tok.pos);
  }
}

/** Parse a search bar query. Returns null for an empty query (match everything). */
export function parseQuery(input: string): Node | null {
  return new Parser(lex(input)).parseQuery();
}
