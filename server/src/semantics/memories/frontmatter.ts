// The frontmatter of a memory file and its sections. The frontmatter is the small part of YAML that
// memory files use: keys with plain or quoted values, block values (`|`, `>`), maps nested by
// indentation or written in braces, and lists of `- item` or in brackets. Anything else in it is
// passed over; the body is split by its own Markdown headings.

type Value = string | Value[] | { [key: string]: Value };
interface Line { indent: number; text: string }
/** A part of a body under one heading; the part before the first heading has none. */
export interface Section { heading: string | null; text: string }

function scalar(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replaceAll("''", "'");
  return s;
}

const BLOCK = /^([|>])([+-]?)$/;

/** A block value: the lines under its key, kept apart (`|`) or folded into one (`>`), with its last line break as asked. */
function blockValue(lines: readonly Line[], from: number, indent: number, mark: RegExpExecArray): [string, number] {
  let i = from;
  let parts: string[] = [];
  while (i < lines.length && lines[i]!.indent > indent) {
    parts = [...parts, lines[i]!.text];
    i += 1;
  }
  const text = parts.join(mark[1] === '|' ? '\n' : ' ');
  return [mark[2] === '-' || !text ? text : `${text}\n`, i];
}

/** A value written in braces or brackets with no nesting; anything else stays as written. */
function flowValue(raw: string): Value {
  const inner = raw.slice(1, -1).trim();
  if (/[{}[\]]/.test(inner)) return raw;
  const items = inner ? inner.split(',').map((x) => x.trim()) : [];
  if (raw.startsWith('[')) return items.map(scalar);
  const pairs = items.map((x) => /^([^:]+):\s*(.*)$/.exec(x));
  if (pairs.some((p) => !p)) return raw;
  return Object.fromEntries(pairs.map((p) => [p![1]!.trim(), scalar(p![2]!)]));
}

function list(lines: readonly Line[], from: number, indent: number): [Value[], number] {
  let i = from;
  let items: Value[] = [];
  while (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('- ')) {
    items = [...items, scalar(lines[i]!.text.slice(2))];
    i += 1;
  }
  return [items, i];
}

/** The value that starts at line `from`, whose lines are at `indent`; answers it and the line after it. */
function block(lines: readonly Line[], from: number, indent: number): [Value, number] {
  if (lines[from]?.text.startsWith('- ')) return list(lines, from, indent);
  let map: { [key: string]: Value } = {};
  let i = from;
  while (i < lines.length && lines[i]!.indent >= indent) {
    const line = lines[i]!;
    const pair = line.indent === indent ? /^([^:]+):(?:\s+(.*))?$/.exec(line.text) : null;
    if (!pair) {
      i += 1;
      continue;
    }
    const key = pair[1]!.trim();
    const rest = pair[2]?.trim() ?? '';
    const next = lines[i + 1];
    const mark = BLOCK.exec(rest);
    if (mark) {
      const [value, after] = blockValue(lines, i + 1, indent, mark);
      map = { ...map, [key]: value };
      i = after;
    } else if (/^\{.*\}$|^\[.*\]$/.test(rest)) {
      map = { ...map, [key]: flowValue(rest) };
      i += 1;
    } else if (rest !== '') {
      map = { ...map, [key]: scalar(rest) };
      i += 1;
    } else if (next && next.indent === indent && next.text.startsWith('- ')) {
      const [value, after] = list(lines, i + 1, indent);
      map = { ...map, [key]: value };
      i = after;
    } else if (next && next.indent > indent) {
      const [value, after] = block(lines, i + 1, next.indent);
      map = { ...map, [key]: value };
      i = after;
    } else {
      map = { ...map, [key]: '' };
      i += 1;
    }
  }
  return [map, i];
}

/** The fields of a leading `---` block, the block as written, and the body after it; a text without a closed block is all body. */
export function parseFrontmatter(text: string): { fields: Record<string, unknown>; body: string; raw: string } {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { fields: {}, body: text, raw: '' };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { fields: {}, body: text, raw: '' };
  const kept = lines.slice(1, end)
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  const [value] = kept.length ? block(kept, 0, kept[0]!.indent) : [{}];
  const fields = Array.isArray(value) || typeof value === 'string' ? {} : value;
  return { fields, body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''), raw: lines.slice(1, end).join('\n').trim() };
}

/** A body split by its Markdown headings; a line inside a code fence is never a heading. */
export function sectionsOf(body: string): Section[] {
  const start = { sections: [] as Section[], heading: null as string | null, lines: [] as string[], fence: false };
  const close = (s: typeof start): Section[] => {
    const text = s.lines.join('\n').trim();
    return s.heading !== null || text ? [...s.sections, { heading: s.heading, text }] : s.sections;
  };
  const end = body.split('\n').reduce((s, line) => {
    const fence = /^\s*(```|~~~)/.test(line) ? !s.fence : s.fence;
    const h = !fence && !s.fence ? /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) return { sections: close(s), heading: h[1]!, lines: [], fence };
    return { ...s, lines: [...s.lines, line], fence };
  }, start);
  return close(end);
}
