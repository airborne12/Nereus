-- Judges in the control plane (spec 5.7 and 6.5): each judge with its current version, every
-- version as saved, and the runs that judge steps. The verdicts themselves are in Doris.
CREATE TABLE judges (
  id              TEXT        PRIMARY KEY,
  name            TEXT        NOT NULL,
  current_version INT         NOT NULL,
  runs_on_new     BOOLEAN     NOT NULL DEFAULT false,
  budget          BIGINT      NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT        NOT NULL
);

CREATE TABLE judge_versions (
  judge      TEXT        NOT NULL REFERENCES judges (id) ON DELETE CASCADE,
  version    INT         NOT NULL,
  name       TEXT        NOT NULL,
  pick       JSONB       NOT NULL,
  reads      JSONB       NOT NULL,
  criterion  TEXT        NOT NULL,
  model      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT        NOT NULL,
  PRIMARY KEY (judge, version)
);

-- A run is also the queue: a runner takes the oldest queued run, or a running one whose runner
-- has not been heard of for a while.
CREATE TABLE judge_runs (
  id            BIGSERIAL   PRIMARY KEY,
  judge         TEXT        NOT NULL REFERENCES judges (id) ON DELETE CASCADE,
  version       INT         NOT NULL,
  scope         TEXT        NOT NULL CHECK (scope IN ('picked', 'new', 'stale', 'stale-violating', 'failed')),
  status        TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'stopped', 'failed')),
  budget        BIGINT      NOT NULL,
  steps         INT,
  judged        INT         NOT NULL DEFAULT 0,
  input_tokens  BIGINT      NOT NULL DEFAULT 0,
  output_tokens BIGINT      NOT NULL DEFAULT 0,
  error         TEXT,
  runner        TEXT,
  heartbeat_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT        NOT NULL,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX judge_runs_open ON judge_runs (id) WHERE status IN ('queued', 'running');
-- A judge has at most one open run, so two runners never judge its steps at the same time.
CREATE UNIQUE INDEX judge_runs_one_open ON judge_runs (judge) WHERE status IN ('queued', 'running');
