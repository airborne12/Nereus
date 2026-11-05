-- Saved searches, dashboards, favorites, webhooks and alerts. All are shared by the team, as in
-- ClickStack; favorites are per user.

CREATE TABLE saved_searches (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    source       TEXT NOT NULL CHECK (source IN ('logs', 'traces')),
    where_text   TEXT NOT NULL DEFAULT '',
    language     TEXT NOT NULL DEFAULT 'lucene' CHECK (language IN ('lucene', 'sql')),
    filters      JSONB NOT NULL DEFAULT '[]',
    select_text  TEXT NOT NULL DEFAULT '',
    order_by     TEXT NOT NULL DEFAULT '',
    tags         TEXT[] NOT NULL DEFAULT '{}',
    created_by   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dashboards (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    -- [{id, title, chart: {source, display, series, where, language, filters, groupBy}, w}]
    tiles        JSONB NOT NULL DEFAULT '[]',
    tags         TEXT[] NOT NULL DEFAULT '{}',
    created_by   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE favorites (
    user_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind     TEXT NOT NULL CHECK (kind IN ('search', 'dashboard')),
    item_id  BIGINT NOT NULL,
    PRIMARY KEY (user_id, kind, item_id)
);

-- Where alerts are sent. Only admins manage them, so members cannot make the server call an
-- address of their choosing.
CREATE TABLE webhooks (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    url         TEXT NOT NULL CHECK (url ~ '^https?://'),
    created_by  BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
    id               BIGSERIAL PRIMARY KEY,
    saved_search_id  BIGINT NOT NULL REFERENCES saved_searches (id) ON DELETE CASCADE,
    webhook_id       BIGINT NOT NULL REFERENCES webhooks (id) ON DELETE RESTRICT,
    threshold_type   TEXT NOT NULL CHECK (threshold_type IN ('above', 'below')),
    threshold        DOUBLE PRECISION NOT NULL,
    interval_seconds INT NOT NULL CHECK (interval_seconds IN (60, 300, 900, 1800, 3600, 21600, 43200, 86400)),
    state            TEXT NOT NULL DEFAULT 'OK' CHECK (state IN ('OK', 'ALERT', 'ERROR')),
    last_checked_at  TIMESTAMPTZ,
    last_value       DOUBLE PRECISION,
    silenced_until   TIMESTAMPTZ,
    created_by       BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alerts_due_idx ON alerts (last_checked_at);

CREATE TABLE alert_history (
    id          BIGSERIAL PRIMARY KEY,
    alert_id    BIGINT NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
    checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    value       DOUBLE PRECISION,
    state       TEXT NOT NULL,
    error       TEXT,
    notified    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX alert_history_alert_idx ON alert_history (alert_id, checked_at DESC);
