// Transcripts written by a loop, for the sequence tests: many turns of tool calls over a few tools
// and targets, some failing, with replies, a compaction and repeated inputs. The choices come from
// a fixed pseudo-random series, so every run writes the same files.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, unknown>;

const TOOLS = ['Read', 'Edit', 'Bash', 'Grep'] as const;
/** The files the tools act on, the commands they run, and what the user says when not the default. */
export interface Lists { files: string[]; commands: string[]; inputs?: string[] }
const PLAIN: Lists = { files: ['src/clock.py', 'src/zone.py', 'tests/clock_test.py'], commands: ['pytest tests/clock_test.py', 'ls src', 'git status', 'pytest -k zone'] };
/** Files and commands that the safety rules look for, among harmless ones. */
export const RISKY: Lists = {
  files: ['src/clock.py', '.env', 'tests/clock_test.py'],
  commands: ['pytest tests/clock_test.py', 'ls src', 'rm -f build.log', 'curl -s https://example.net/health', 'sudo make install', 'git push --force', 'rsync -a a b', 'echo alarm'],
  // Agreements, refusals that hold a word of agreement, and a message of the harness.
  inputs: ['Fix the failing test', 'yes', 'Yes, go ahead', '不可以', 'No, do not proceed', '可以，删吧', '<task-notification>done</task-notification>', 'ok, but wait', 'continue'],
};
const INPUTS = ['Fix the failing test', 'yes', 'Yes, go ahead', 'continue', 'Now the zone module'];
const REPLIES = ['Done.', 'Should I delete the old file?', 'The tests pass.', 'Fixed the clock. Should I also update the docs?'];

/** A fixed series of whole numbers below `n`; the same seed gives the same series. */
function series(seed: number): (n: number) => number {
  let x = seed;
  return (n) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return Math.floor((x / 2147483648) * n);
  };
}

/** The lines of one session of `turns` turns. */
export function sequenceLines(id: string, seed: number, turns: number, day = '2026-11-17', lists: Lists = PLAIN): string[] {
  const { files: FILES, commands: COMMANDS, inputs: SAID = INPUTS } = lists;
  const pick = series(seed);
  let clock = Date.parse(`${day}T09:00:00Z`);
  let n = 0;
  const row = (r: Row): Row => {
    clock += 1000;
    return { timestamp: new Date(clock).toISOString(), version: '2.1.322', sessionId: id, ...r };
  };
  const user = (content: unknown, extra: Row = {}): Row => row({ type: 'user', uuid: `u${n += 1}`, message: { role: 'user', content }, ...extra });
  const assistant = (msg: string, index: number, item: Row, stop: string): Row => row({
    type: 'assistant', uuid: `${msg}-${index}`, requestId: `req_${msg}`, apiBlockIndex: index,
    message: { id: msg, role: 'assistant', model: 'claude-opus-5-5', content: [item], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } },
  });
  const rows: Row[] = [{ type: 'ai-title', aiTitle: `Sequences ${id}`, sessionId: id }];
  for (let t = 0; t < turns; t += 1) {
    rows.push(user(SAID[pick(SAID.length)]!));
    const calls = 1 + pick(5);
    for (let c = 0; c < calls; c += 1) {
      const msg = `m${n += 1}`;
      // One model call issues one tool call, or two side by side.
      const issued = Array.from({ length: 1 + (pick(4) === 0 ? 1 : 0) }, (_, i) => {
        const tool = TOOLS[pick(TOOLS.length)]!;
        const input = tool === 'Bash' ? { command: COMMANDS[pick(COMMANDS.length)]! } : tool === 'Grep' ? { pattern: 'now\\(', path: FILES[pick(FILES.length)]! } : { file_path: FILES[pick(FILES.length)]! };
        return { id: `${msg}-t${i}`, tool, input, failed: tool === 'Bash' && pick(3) === 0 };
      });
      issued.forEach((x, i) => rows.push(assistant(msg, i, { type: 'tool_use', id: x.id, name: x.tool, input: x.input }, 'tool_use')));
      issued.forEach((x) => rows.push(user([{ type: 'tool_result', tool_use_id: x.id, content: x.failed ? 'FAILED' : 'ok', is_error: x.failed }])));
    }
    // Some replies think first, so their text is not the first block of the message.
    const msg = `m${n += 1}`;
    const thinks = pick(3) === 0;
    if (thinks) rows.push(assistant(msg, 0, { type: 'thinking', thinking: '', signature: 'sig' }, 'end_turn'));
    rows.push(assistant(msg, thinks ? 1 : 0, { type: 'text', text: REPLIES[pick(REPLIES.length)]! }, 'end_turn'));
    if (t === Math.floor(turns / 2)) {
      rows.push(row({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 9000, postTokens: 400 } }));
      rows.push(user(`Summary of ${id}.`, { isCompactSummary: true, isVisibleInTranscriptOnly: true }));
    }
  }
  return rows.map((r) => JSON.stringify(r));
}

export const SEQ_A = 'fx-seq-0001';
export const SEQ_B = 'fx-seq-0002';

/** Writes two generated sessions into `dir` and returns their files. */
export function writeSequences(dir: string): string[] {
  return [[SEQ_A, 7, 40] as const, [SEQ_B, 99, 25] as const].map(([id, seed, turns]) => {
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, `${sequenceLines(id, seed, turns).join('\n')}\n`);
    return file;
  });
}
