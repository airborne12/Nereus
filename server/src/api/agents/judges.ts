// The Judges routes (spec 7): the list, one judge in a view, the verdicts of one step with what
// the model read, a preview of a new judge with a try on a few steps, and the writes that save a
// judge or a version or queue a rerun. Writes and tries are for admins: they spend model tokens.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson } from '../../control/auth/http.ts';
import { AuthError, type User } from '../../control/auth/store.ts';
import type { JudgeStore } from '../../control/judges/store.ts';
import type { Doris } from '../../db/doris.ts';
import { CompileError } from '../../semantics/search/compile.ts';
import { type JudgeVersion, parseDraft, pickText, readsText } from '../../semantics/judges/judge.ts';
import { type JudgeModel, ModelAccessError } from '../../semantics/judges/model.ts';
import { estimateTokens } from '../../semantics/judges/prompt.ts';
import { judgeExcerpts, readSteps } from '../../semantics/judges/runner.ts';
import { countSql, lineageSql, readsSql, sampleSql } from '../../semantics/judges/statements.ts';
import { judgesSql, verdictSql, verdictsSql, type View } from '../../semantics/judges/views.ts';
import { parsed, run, type Send } from './request.ts';

export interface JudgeAccess { store: JudgeStore; model: JudgeModel }
interface Deps { doris: Doris; db: string; send: Send; judges?: JudgeAccess }

const ID = '([a-z0-9-]{1,64})';
const ONE = new RegExp(`^/api/agents/judges/${ID}$`);
const WRITE = new RegExp(`^/api/agents/judges/${ID}/(versions|reruns)$`);
const STEP = new RegExp(`^/api/agents/judges/${ID}/steps/([^/]+)/(\\d+)$`);
const VIEWS: readonly View[] = ['first', 'all', 'changed'];
/** The largest budget of input tokens a run may be given. */
const MAX_BUDGET = 50_000_000;

function admin(user: User | undefined): User {
  if (!user || user.role !== 'admin') throw new AuthError(403, 'only admins can change judges or run them: a run calls the model and spends tokens');
  return user;
}

function budgetOf(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > MAX_BUDGET) throw new CompileError(`budget must be a whole number of input tokens from 1 to ${MAX_BUDGET}`);
  return raw as number;
}

const counted = (r: Record<string, unknown> | undefined) => ({
  judged: Number(r?.judged ?? 0), violations: Number(r?.violations ?? 0), sessions: Number(r?.sessions ?? 0),
  stale: Number(r?.stale ?? 0), staleViolating: Number(r?.stale_violating ?? 0), tokensPerStep: Number(r?.tokens_per_step ?? 0),
});

async function list(d: Deps, j: JudgeAccess, res: ServerResponse): Promise<void> {
  const all = await j.store.overview();
  const statement = judgesSql(d.db, all.map((x) => ({ id: x.judge.id, currentVersion: x.judge.currentVersion })));
  const { results, elapsedMs } = await run(d.doris, statement ? [statement] : []);
  const counts = new Map((results[0] ?? []).map((r) => [String(r.judge), r]));
  d.send(res, 200, {
    rows: all.map(({ judge, current, lastRun }) => {
      const c = counts.get(judge.id);
      return { ...judge, version: current.version, pick: current.pick, pickText: pickText(current.pick), reads: current.reads, criterion: current.criterion, model: current.model,
        lastRun, ...counted(c), lastJudged: c?.last_judged ?? null };
    }),
    sql: statement ? [statement] : [], elapsedMs,
  });
}

async function one(d: Deps, j: JudgeAccess, res: ServerResponse, id: string, url: URL): Promise<void> {
  const view = (url.searchParams.get('view') ?? 'first') as View;
  if (!VIEWS.includes(view)) throw new CompileError("'view' must be first, all or changed");
  const judge = await j.store.judge(id);
  if (!judge) return d.send(res, 404, { error: 'no such judge' });
  const [versions, runs] = await Promise.all([j.store.versions(id), j.store.runs(id)]);
  const statements = [lineageSql(d.db, id, judge.currentVersion), verdictsSql(d.db, id, judge.currentVersion, view)];
  const { results, elapsedMs } = await run(d.doris, statements);
  const current = versions.find((v) => v.version === judge.currentVersion)!;
  d.send(res, 200, {
    judge, versions, runs, pickText: pickText(current.pick), readsText: readsText(current.reads),
    counts: counted(results[0]![0]), view, rows: parsed(results[1]!), sql: statements, elapsedMs,
  });
}

async function step(d: Deps, j: JudgeAccess, res: ServerResponse, id: string, session: string, seq: number): Promise<void> {
  const judge = await j.store.judge(id);
  if (!judge) return d.send(res, 404, { error: 'no such judge' });
  const current = (await j.store.versions(id)).find((v) => v.version === judge.currentVersion)!;
  const verdicts = verdictSql(d.db, id, session, seq);
  const started = performance.now();
  const [rows, read] = await Promise.all([d.doris.query(verdicts.sql), readSteps(d, current, [{ session_id: session, seq }])]);
  d.send(res, 200, {
    verdicts: rows.map((r) => ({ ...r, input_seqs: typeof r.input_seqs === 'string' ? JSON.parse(r.input_seqs) : r.input_seqs })),
    read: read[0]?.text ?? null, sql: [verdicts, readsSql(d.db, current.reads, [{ session_id: session, seq }])], elapsedMs: Math.round(performance.now() - started),
  });
}

async function preview(d: Deps, j: JudgeAccess, req: IncomingMessage, res: ServerResponse, user: User | undefined): Promise<void> {
  const body = await readJson(req);
  const trying = body.try === true;
  if (trying) admin(user);
  const criterion = typeof body.criterion === 'string' ? body.criterion : '';
  if (trying && !criterion.trim()) throw new CompileError('criterion must not be empty');
  const draft = parseDraft({ ...body, name: 'preview', criterion: criterion.trim() ? criterion : 'none' });
  const statements = [countSql(d.db, draft.pick), sampleSql(d.db, draft.pick)];
  const { results, elapsedMs } = await run(d.doris, statements);
  const sampled = results[1]!.map((r) => ({ session_id: String(r.session_id), seq: Number(r.seq), ts: r.ts, step: Number(r.step) }));
  const excerpts = await readSteps(d, draft, sampled);
  const steps = Number(results[0]![0]?.steps ?? 0);
  const each = excerpts.length ? excerpts.reduce((n, x) => n + estimateTokens(draft.criterion, x.text), 0) / excerpts.length : 0;
  const v: JudgeVersion = { judge: 'preview', version: 1, ...draft, createdAt: '', createdBy: user?.email ?? '' };
  let verdicts: { verdict: string; reason: string }[] = [];
  if (trying) {
    try {
      verdicts = await judgeExcerpts(j, v, excerpts);
    } catch (e) {
      if (e instanceof ModelAccessError) return d.send(res, 503, { error: e.message });
      return d.send(res, 502, { error: `The model could not be used: ${(e as Error).message}` });
    }
  }
  d.send(res, 200, {
    steps, sessions: Number(results[0]![0]?.sessions ?? 0), estimate: Math.round(steps * each),
    sample: excerpts.map((x, i) => ({ session_id: x.session_id, seq: x.seq, ts: sampled.find((s) => s.seq === x.seq && s.session_id === x.session_id)?.ts ?? null, text: x.text, ...(verdicts[i] ? { verdict: verdicts[i]!.verdict, reason: verdicts[i]!.reason } : {}) })),
    sql: sampled.length ? [...statements, readsSql(d.db, draft.reads, sampled)] : statements, elapsedMs,
  });
}

async function write(d: Deps, j: JudgeAccess, req: IncomingMessage, res: ServerResponse, user: User | undefined, id: string | null, what: string | null): Promise<void> {
  const by = admin(user).email;
  const body = await readJson(req);
  if (id === null) {
    const created = await j.store.create(parseDraft(body), by, budgetOf(body.budget));
    return d.send(res, 201, created);
  }
  if (what === 'versions') {
    const version = await j.store.addVersion(id, { criterion: String(body.criterion ?? ''), model: String(body.model ?? '') }, by);
    return d.send(res, 201, { version });
  }
  if (body.only !== 'all' && body.only !== 'violates') throw new CompileError("'only' must be all or violates");
  const queued = await j.store.enqueue(id, body.only === 'violates' ? 'stale-violating' : 'stale', by, budgetOf(body.budget));
  d.send(res, 201, { run: queued });
}

/** Answers a request under /api/agents/judges; false when the path is not one of them. */
export async function judgeRoutes(d: Deps, req: IncomingMessage, res: ServerResponse, url: URL, user?: User): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/agents/judges' && !path.startsWith('/api/agents/judges/')) return false;
  const j = d.judges;
  if (!j) {
    d.send(res, 503, { error: 'judges are not set up on this server' });
    return true;
  }
  const stepMatch = STEP.exec(path);
  const oneMatch = ONE.exec(path);
  const writeMatch = WRITE.exec(path);
  if (req.method === 'GET' && path === '/api/agents/judges') await list(d, j, res);
  else if (req.method === 'POST' && path === '/api/agents/judges/preview') await preview(d, j, req, res, user);
  else if (req.method === 'POST' && path === '/api/agents/judges') await write(d, j, req, res, user, null, null);
  else if (req.method === 'GET' && stepMatch) await step(d, j, res, stepMatch[1]!, decodeURIComponent(stepMatch[2]!), Number(stepMatch[3]));
  else if (req.method === 'GET' && oneMatch) await one(d, j, res, oneMatch[1]!, url);
  else if (req.method === 'POST' && writeMatch) await write(d, j, req, res, user, writeMatch[1]!, writeMatch[2]!);
  else d.send(res, 404, { error: 'not found' });
  return true;
}
