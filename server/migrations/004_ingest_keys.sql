-- Ingestion keys for the browser SDK. They are embedded in public web pages, so they only allow
-- writing session data (POST /api/ingest/sessions) and are never accepted by the rest of the API:
-- their prefix differs from API keys' and they live in their own table. Admins manage them.
CREATE TABLE ingest_keys (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    prefix       TEXT NOT NULL,
    key_hash     BYTEA NOT NULL UNIQUE,
    created_by   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);
