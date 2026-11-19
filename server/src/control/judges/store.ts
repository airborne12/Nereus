// Judges in PostgreSQL (spec 5.7 and 6.5): each judge's current version and schedule, its saved
// versions, and its runs. A run is a row of the queue the judge runner takes work from.

import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { type JudgeDraft, type JudgeVersion, MODELS, type Pick, type Reads } from '../../semantics/judges/judge.ts';
import type { Scope } from '../../semantics/judges/statements.ts';
import { AuthError } from '../auth/store.ts';

export type RunStatus = 'queued' | 'running' | 'done' | 'stopped' | 'failed';
export interface JudgeRecord { id: string; name: string; currentVersion: number; runsOnNew: boolean; createdAt: string; createdBy: string }
export interface RunRecord {
  id: number; judge: string; version: number; scope: Scope; status: RunStatus; budget: number; steps: number | null; judged: number;
  inputTokens: number; outputTokens: number; error: string | null; createdAt: string; createdBy: string; startedAt: string | null; finishedAt: string | null;
}

/** Input tokens a run may spend unless it is given another budget. */
export const RUN_BUDGET = 2_000_000;
/** Minutes after which a running run whose runner has gone quiet can be taken by another. */
export const QUIET_MINUTES = 10;

const time = (col: string, as: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS ${as}`;
const JUDGE_COLS = `id, name, current_version, runs_on_new, ${time('created_at', 'created_at')}, created_by`;
const VERSION_COLS = `judge, version, name, pick, reads, criterion, model, ${time('created_at', 'created_at')}, created_by`;
const RUN_COLS = `id, judge, version, scope, status, budget, steps, judged, input_tokens, output_tokens, error, ${time('created_at', 'created_at')}, created_by, `
  + `${time('started_at', 'started_at')}, ${time('finished_at', 'finished_at')}`;

type Row = Record<string, unknown>;
const judgeOf = (r: Row): JudgeRecord => ({ id: String(r.id), name: String(r.name), currentVersion: Number(r.current_version), runsOnNew: r.runs_on_new === true, createdAt: String(r.created_at), createdBy: String(r.created_by) });
const versionOf = (r: Row): JudgeVersion => ({
  judge: String(r.judge), version: Number(r.version), name: String(r.name), pick: r.pick as Pick, reads: r.reads as Reads,
  criterion: String(r.criterion), model: String(r.model), createdAt: String(r.created_at), createdBy: String(r.created_by),
});
const runOf = (r: Row): RunRecord => ({
  id: Number(r.id), judge: String(r.judge), version: Number(r.version), scope: r.scope as Scope, status: r.status as RunStatus, budget: Number(r.budget),
  steps: r.steps === null ? null : Number(r.steps), judged: Number(r.judged), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
  error: r.error === null ? null : String(r.error), createdAt: String(r.created_at), createdBy: String(r.created_by),
  startedAt: r.started_at === null ? null : String(r.started_at), finishedAt: r.finished_at === null ? null : String(r.finished_at),
});

/** The id of a judge: its name in lower case with dashes, and a random tail. */
export function judgeId(name: string, tail: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${slug || 'judge'}-${tail}`;
}

export class JudgeStore {
  private readonly pool: pg.Pool;
  private readonly tail: () => string;

  constructor(pool: pg.Pool, tail: () => string = () => randomBytes(3).toString('hex')) {
    this.pool = pool;
    this.tail = tail;
  }

  private async inTransaction<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await work(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  /** A new judge, its first version and a queued run of the steps it picks. */
  async create(d: JudgeDraft, by: string, budget = RUN_BUDGET): Promise<{ judge: JudgeRecord; run: RunRecord }> {
    const id = judgeId(d.name, this.tail());
    return this.inTransaction(async (c) => {
      const judge = (await c.query(`INSERT INTO judges (id, name, current_version, runs_on_new, created_by) VALUES ($1, $2, 1, $3, $4) RETURNING ${JUDGE_COLS}`, [id, d.name, d.runsOnNew, by])).rows[0];
      await c.query('INSERT INTO judge_versions (judge, version, name, pick, reads, criterion, model, created_by) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)',
        [id, d.name, JSON.stringify(d.pick), JSON.stringify(d.reads), d.criterion, d.model, by]);
      const run = (await c.query(`INSERT INTO judge_runs (judge, version, scope, budget, created_by) VALUES ($1, 1, 'picked', $2, $3) RETURNING ${RUN_COLS}`, [id, budget, by])).rows[0];
      return { judge: judgeOf(judge), run: runOf(run) };
    });
  }

  /** A new version with another criterion or model; it judges nothing until a run is queued. */
  async addVersion(id: string, change: { criterion: string; model: string }, by: string): Promise<JudgeVersion> {
    const criterion = change.criterion.trim();
    if (!criterion) throw new AuthError(400, 'criterion must not be empty');
    if (!MODELS.includes(change.model as (typeof MODELS)[number])) throw new AuthError(400, `model must be one of ${MODELS.join(', ')}`);
    return this.inTransaction(async (c) => {
      const j = (await c.query('SELECT current_version FROM judges WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!j) throw new AuthError(404, 'no such judge');
      const cur = versionOf((await c.query(`SELECT ${VERSION_COLS} FROM judge_versions WHERE judge = $1 AND version = $2`, [id, j.current_version])).rows[0]);
      if (cur.criterion === criterion && cur.model === change.model) throw new AuthError(400, 'nothing changed: the criterion and the model are those of the current version');
      const next = cur.version + 1;
      const row = (await c.query(`INSERT INTO judge_versions (judge, version, name, pick, reads, criterion, model, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${VERSION_COLS}`,
        [id, next, cur.name, JSON.stringify(cur.pick), JSON.stringify(cur.reads), criterion, change.model, by])).rows[0];
      await c.query('UPDATE judges SET current_version = $2 WHERE id = $1', [id, next]);
      return versionOf(row);
    });
  }

  /** A queued run of the judge's current version. */
  async enqueue(id: string, scope: Scope, by: string, budget = RUN_BUDGET): Promise<RunRecord> {
    const r = await this.pool.query(`INSERT INTO judge_runs (judge, version, scope, budget, created_by)
      SELECT id, current_version, $2, $3, $4 FROM judges WHERE id = $1 RETURNING ${RUN_COLS}`, [id, scope, budget, by]);
    if (!r.rows[0]) throw new AuthError(404, 'no such judge');
    return runOf(r.rows[0]);
  }

  /** Every judge, newest first, with its current version and its last run. */
  async overview(): Promise<{ judge: JudgeRecord; current: JudgeVersion; lastRun: RunRecord | null }[]> {
    // Inside each subquery the columns are those of its one table.
    const r = await this.pool.query(`SELECT row_to_json(j) AS judge, row_to_json(v) AS current, row_to_json(r) AS last_run
      FROM (SELECT ${JUDGE_COLS} FROM judges) j
      JOIN (SELECT ${VERSION_COLS} FROM judge_versions) v ON v.judge = j.id AND v.version = j.current_version
      LEFT JOIN LATERAL (SELECT ${RUN_COLS} FROM judge_runs x WHERE x.judge = j.id ORDER BY x.id DESC LIMIT 1) r ON true
      ORDER BY j.created_at DESC, j.id`);
    return r.rows.map((row) => ({ judge: judgeOf(row.judge), current: versionOf(row.current), lastRun: row.last_run ? runOf(row.last_run) : null }));
  }

  async judges(): Promise<JudgeRecord[]> {
    return (await this.pool.query(`SELECT ${JUDGE_COLS} FROM judges ORDER BY created_at, id`)).rows.map(judgeOf);
  }

  async judge(id: string): Promise<JudgeRecord | null> {
    const r = (await this.pool.query(`SELECT ${JUDGE_COLS} FROM judges WHERE id = $1`, [id])).rows[0];
    return r ? judgeOf(r) : null;
  }

  async versions(id: string): Promise<JudgeVersion[]> {
    return (await this.pool.query(`SELECT ${VERSION_COLS} FROM judge_versions WHERE judge = $1 ORDER BY version`, [id])).rows.map(versionOf);
  }

  async runs(id: string): Promise<RunRecord[]> {
    return (await this.pool.query(`SELECT ${RUN_COLS} FROM judge_runs WHERE judge = $1 ORDER BY id`, [id])).rows.map(runOf);
  }

  async hasOpenRun(id: string): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM judge_runs WHERE judge = $1 AND status IN ('queued', 'running') LIMIT 1", [id])).rowCount === 1;
  }

  /** Takes the oldest queued run, or a running one whose runner has gone quiet. */
  async claim(runner: string): Promise<RunRecord | null> {
    const r = await this.pool.query(`UPDATE judge_runs SET status = 'running', runner = $1, heartbeat_at = now(), started_at = coalesce(started_at, now())
      WHERE id = (
        SELECT id FROM judge_runs
        WHERE status = 'queued' OR (status = 'running' AND heartbeat_at < now() - make_interval(mins => $2))
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) RETURNING ${RUN_COLS}`, [runner, QUIET_MINUTES]);
    return r.rows[0] ? runOf(r.rows[0]) : null;
  }

  async started(runId: number, steps: number): Promise<void> {
    await this.pool.query('UPDATE judge_runs SET steps = $2, heartbeat_at = now() WHERE id = $1', [runId, steps]);
  }

  /** How far a run has come, in totals; also tells the queue the runner is alive. */
  async progress(runId: number, judged: number, inputTokens: number, outputTokens: number): Promise<void> {
    await this.pool.query('UPDATE judge_runs SET judged = $2, input_tokens = $3, output_tokens = $4, heartbeat_at = now() WHERE id = $1', [runId, judged, inputTokens, outputTokens]);
  }

  async finish(runId: number, status: Exclude<RunStatus, 'queued' | 'running'>, error: string | null = null): Promise<void> {
    await this.pool.query('UPDATE judge_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1', [runId, status, error]);
  }
}
