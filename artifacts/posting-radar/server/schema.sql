CREATE TABLE IF NOT EXISTS radar_users (
  id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS radar_preferences (
  user_id text PRIMARY KEY REFERENCES radar_users(id), revision integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS radar_preference_history (
  user_id text NOT NULL REFERENCES radar_users(id), revision integer NOT NULL,
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,revision)
);
CREATE TABLE IF NOT EXISTS radar_snapshots (
  id uuid PRIMARY KEY, source_id text NOT NULL, content_hash text NOT NULL, raw text NOT NULL,
  rows jsonb NOT NULL, parser_version integer NOT NULL, etag text, last_modified text,
  fetched_at timestamptz NOT NULL DEFAULT now(), validated boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS radar_snapshot_source ON radar_snapshots(source_id,fetched_at DESC);
CREATE TABLE IF NOT EXISTS radar_cursors (
  user_id text NOT NULL REFERENCES radar_users(id), source_id text NOT NULL,
  snapshot_id uuid NOT NULL REFERENCES radar_snapshots(id), processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,source_id)
);
CREATE TABLE IF NOT EXISTS radar_runs (
  id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES radar_users(id), idempotency_key text NOT NULL,
  requested_sources jsonb NOT NULL, preference_revision integer NOT NULL, preferences jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','degraded','failed','interrupted')),
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, totals jsonb NOT NULL DEFAULT '{}',
  next_sequence integer NOT NULL DEFAULT 0, worker_token uuid, retry_of uuid REFERENCES radar_runs(id),
  UNIQUE(user_id,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS radar_one_active_run ON radar_runs(user_id) WHERE state IN ('queued','running');
CREATE TABLE IF NOT EXISTS radar_run_sources (
  run_id uuid NOT NULL REFERENCES radar_runs(id), source_id text NOT NULL,
  baseline_id uuid REFERENCES radar_snapshots(id), candidate_id uuid REFERENCES radar_snapshots(id),
  result jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(run_id,source_id)
);
CREATE TABLE IF NOT EXISTS radar_events (
  run_id uuid NOT NULL REFERENCES radar_runs(id), sequence integer NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(run_id,sequence)
);
CREATE TABLE IF NOT EXISTS radar_postings (
  identity text PRIMARY KEY, payload jsonb NOT NULL, fingerprint text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS radar_seen (
  user_id text NOT NULL REFERENCES radar_users(id), source_id text NOT NULL, identity text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,source_id,identity)
);
CREATE TABLE IF NOT EXISTS radar_tracker (
  id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES radar_users(id),
  identity text NOT NULL REFERENCES radar_postings(identity), source_id text NOT NULL, season text NOT NULL,
  status text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved','applied','skipped')),
  revision integer NOT NULL DEFAULT 1, discovered_run uuid NOT NULL REFERENCES radar_runs(id),
  reasons jsonb NOT NULL, data_origin text NOT NULL CHECK (data_origin IN ('live','cache')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,identity)
);
CREATE INDEX IF NOT EXISTS radar_tracker_user ON radar_tracker(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS radar_guest_sessions (
  id uuid PRIMARY KEY, user_id text NOT NULL UNIQUE REFERENCES radar_users(id),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE TABLE IF NOT EXISTS radar_run_matches (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES radar_runs(id),
  identity text NOT NULL REFERENCES radar_postings(identity), posting jsonb NOT NULL,
  source_id text NOT NULL, season text NOT NULL, reasons jsonb NOT NULL, data_origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,identity)
);
CREATE TABLE IF NOT EXISTS radar_guest_imports (
  guest_run_id uuid NOT NULL REFERENCES radar_runs(id), user_id text NOT NULL REFERENCES radar_users(id),
  account_run_id uuid NOT NULL REFERENCES radar_runs(id), PRIMARY KEY(guest_run_id,user_id)
);
