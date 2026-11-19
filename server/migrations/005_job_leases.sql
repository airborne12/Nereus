-- Leases of the jobs (spec 6.5): one row per unit of work a job holds. For the rules job a unit is
-- a session tree. A lease that has expired can be taken by any holder.
CREATE TABLE job_leases (
  job        TEXT        NOT NULL,
  unit       TEXT        NOT NULL,
  holder     TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job, unit)
);
