// The object a tool call acts on (spec 6.2, "Resource"): one argument chosen per tool name.

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function resourceOf(tool: string, args: unknown): string | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) if (typeof a[k] === 'string' && a[k] !== '') return a[k] as string;
    return null;
  };
  if (FILE_TOOLS.has(tool)) return pick('file_path', 'notebook_path');
  if (tool === 'Glob' || tool === 'Grep') return pick('path', 'pattern');
  if (tool === 'WebFetch') return pick('url');
  if (tool === 'WebSearch') return pick('query');
  if (tool === 'Bash') return pick('command');
  return null;
}
