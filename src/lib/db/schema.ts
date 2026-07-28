/**
 * Database schema.
 *
 * The DDL is kept as a TypeScript string rather than a `.sql` file on disk so
 * it is always bundled with the server build and never depends on a runtime
 * file path. Every statement is idempotent, so the schema is applied on the
 * first database connection and `npm run dev` works with no migration step.
 *
 * SQLite is the right default here: the workload is a single-writer analysis
 * pipeline with read-heavy dashboards. The repository layer in this folder is
 * the only place that touches SQL, so swapping to Postgres later means
 * reimplementing these modules and nothing else.
 */
export const SCHEMA_SQL = `
-- Operator-editable settings, e.g. the transcript vendor credential chosen in
-- the UI. Environment variables take precedence over anything stored here.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  channel_id       TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  handle           TEXT,
  thumbnail_url    TEXT,
  subscriber_count INTEGER,
  video_count      INTEGER,
  view_count       INTEGER,
  updated_at       TEXT NOT NULL
);

-- PRD Mode B: channels the user wants monitored for new episodes.
CREATE TABLE IF NOT EXISTS tracked_channels (
  channel_id      TEXT PRIMARY KEY,
  label           TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  created_at      TEXT NOT NULL
);

-- One row per pipeline execution. Powers the dashboard's "today" counters and
-- gives every clip a traceable origin.
CREATE TABLE IF NOT EXISTS runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  mode                 TEXT NOT NULL,
  topic                TEXT,
  channel_ids          TEXT NOT NULL DEFAULT '[]',
  engine               TEXT NOT NULL,
  episode_threshold    INTEGER NOT NULL,
  clip_threshold       INTEGER NOT NULL,
  episodes_discovered  INTEGER NOT NULL DEFAULT 0,
  episodes_analysed    INTEGER NOT NULL DEFAULT 0,
  episodes_skipped     INTEGER NOT NULL DEFAULT 0,
  clips_found          INTEGER NOT NULL DEFAULT 0,
  warnings             TEXT NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL DEFAULT 'running',
  error                TEXT,
  started_at           TEXT NOT NULL,
  finished_at          TEXT,
  duration_ms          INTEGER
);

CREATE TABLE IF NOT EXISTS episodes (
  video_id             TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL,
  channel_title        TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  published_at         TEXT NOT NULL,
  duration_seconds     INTEGER NOT NULL,
  view_count           INTEGER NOT NULL DEFAULT 0,
  like_count           INTEGER NOT NULL DEFAULT 0,
  comment_count        INTEGER NOT NULL DEFAULT 0,
  thumbnail_url        TEXT,
  tags                 TEXT NOT NULL DEFAULT '[]',
  has_captions         INTEGER,
  -- Reuse rights: 'youtube' (standard, needs permission) or 'creativeCommon'
  -- (CC BY, reusable with attribution). Critical when mining channels you do
  -- not own. Also added by applyColumnMigrations for pre-existing databases.
  license              TEXT,
  embeddable           INTEGER,
  -- Step 2 output
  opportunity_score    REAL,
  opportunity_factors  TEXT,
  opportunity_reasons  TEXT NOT NULL DEFAULT '[]',
  -- Pipeline state: discovered | skipped | analysed | failed
  analysis_status      TEXT NOT NULL DEFAULT 'discovered',
  skip_reason          TEXT,
  transcript_source    TEXT,
  segment_count        INTEGER NOT NULL DEFAULT 0,
  clip_count           INTEGER NOT NULL DEFAULT 0,
  topic                TEXT,
  last_run_id          INTEGER,
  discovered_at        TEXT NOT NULL,
  analysed_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodes_channel ON episodes (channel_id);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes (analysis_status);
CREATE INDEX IF NOT EXISTS idx_episodes_score ON episodes (opportunity_score DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_discovered_at ON episodes (discovered_at DESC);

-- Transcript cache. Transcription is the most expensive step in the pipeline,
-- so it is fetched at most once per video.
CREATE TABLE IF NOT EXISTS transcripts (
  video_id     TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  language     TEXT NOT NULL,
  duration_sec REAL NOT NULL,
  word_count   INTEGER NOT NULL,
  cues         TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id          TEXT NOT NULL,
  run_id            INTEGER,
  segment_index     INTEGER NOT NULL,
  title             TEXT NOT NULL,
  start_sec         REAL NOT NULL,
  end_sec           REAL NOT NULL,
  duration_sec      REAL NOT NULL,
  -- Step 5 / Step 6 output
  final_score       INTEGER NOT NULL,
  confidence        INTEGER NOT NULL,
  tier              TEXT NOT NULL,
  category          TEXT NOT NULL,
  dimensions        TEXT NOT NULL,
  -- Step 8 / Step 10 metadata
  why_this_works    TEXT NOT NULL DEFAULT '[]',
  suggested_hook    TEXT NOT NULL DEFAULT '',
  suggested_caption TEXT NOT NULL DEFAULT '',
  editing_notes     TEXT NOT NULL DEFAULT '',
  transcript        TEXT NOT NULL DEFAULT '',
  engine            TEXT NOT NULL,
  -- Editor workflow: new | approved | rejected | published
  status            TEXT NOT NULL DEFAULT 'new',
  created_at        TEXT NOT NULL,
  UNIQUE (video_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_clips_video ON clips (video_id);
CREATE INDEX IF NOT EXISTS idx_clips_score ON clips (final_score DESC);
CREATE INDEX IF NOT EXISTS idx_clips_tier ON clips (tier);
CREATE INDEX IF NOT EXISTS idx_clips_category ON clips (category);
CREATE INDEX IF NOT EXISTS idx_clips_created_at ON clips (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_run ON clips (run_id);

-- PRD "Long-term AI Learning" / "Long-term Moat".
-- Editor decisions are the labelled dataset that lets the ranking model
-- improve beyond whatever the base LLM can do.
CREATE TABLE IF NOT EXISTS clip_feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id     INTEGER NOT NULL,
  verdict     TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clip_feedback_clip ON clip_feedback (clip_id);

-- Published performance, pulled from connected analytics. The supervision
-- signal for the future ranking model.
CREATE TABLE IF NOT EXISTS clip_performance (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id         INTEGER NOT NULL,
  platform        TEXT NOT NULL,
  external_url    TEXT,
  views           INTEGER,
  retention_pct   REAL,
  ctr_pct         REAL,
  shares          INTEGER,
  comments        INTEGER,
  likes           INTEGER,
  measured_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clip_performance_clip ON clip_performance (clip_id);
`;
