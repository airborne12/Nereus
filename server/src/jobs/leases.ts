// Leases in PostgreSQL (spec 6.5): a job takes the lease of a unit of work before it does the
// work, so two runners do not do the same unit at once. A lease ends when it is released or when
// its time is up, which frees the unit of a runner that died.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface LeaseStore {
  take(job: string, unit: string, seconds: number): Promise<boolean>;
  release(job: string, unit: string): Promise<void>;
}

export class Leases implements LeaseStore {
  readonly holder: string;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool, holder: string = randomUUID()) {
    this.pool = pool;
    this.holder = holder;
  }

  /** Takes the lease of a unit for some seconds; false when another holder has it. */
  async take(job: string, unit: string, seconds: number): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO job_leases (job, unit, holder, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))
       ON CONFLICT (job, unit) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE job_leases.expires_at < now() OR job_leases.holder = EXCLUDED.holder`,
      [job, unit, this.holder, seconds],
    );
    return r.rowCount === 1;
  }

  /** Gives a lease back; a lease another holder has taken since is left alone. */
  async release(job: string, unit: string): Promise<void> {
    await this.pool.query('DELETE FROM job_leases WHERE job = $1 AND unit = $2 AND holder = $3', [job, unit, this.holder]);
  }
}
