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
  -- Hybrid render integration (shorts render service).
  -- status: none | rendering | done | error
  render_status     TEXT NOT NULL DEFAULT 'none',
  render_job_id     TEXT,
  render_path       TEXT,
  render_error      TEXT,
  -- Phase 2: SEO metadata generated by the LLM (comma-joined JSON arrays).
  seo_title         TEXT,
  seo_description   TEXT,
  seo_tags          TEXT NOT NULL DEFAULT '[]',
  seo_generated_at  TEXT,
  -- Phase 3: publish integration (auto-post to YouTube/TikTok/Reels).
  -- status: none | publishing | published | error
  publish_status    TEXT NOT NULL DEFAULT 'none',
  publish_url       TEXT,
  publish_error     TEXT,
  published_at      TEXT,
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

-- Phase 2 (Master Task Brief §22): boundary-adjustment feedback details.
-- Stored as JSON: { original_start_sec, original_end_sec, new_start_sec,
--   new_end_sec, reason } so every manual correction is auditable.
CREATE TABLE IF NOT EXISTS clip_feedback_boundary (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id     INTEGER NOT NULL,
  feedback_id INTEGER,
  original_start_sec REAL,
  original_end_sec REAL,
  new_start_sec REAL,
  new_end_sec REAL,
  reason      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clip_feedback_boundary_clip ON clip_feedback_boundary (clip_id);

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

-- Phase 2 (Master Task Brief §19): asynchronous render jobs.
-- Job state lives in the DB so a service restart does not lose it.
CREATE TABLE IF NOT EXISTS render_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL UNIQUE,
  episode_id  TEXT,
  mode        TEXT NOT NULL DEFAULT 'final',
  status      TEXT NOT NULL DEFAULT 'queued',
  request     TEXT,
  response    TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_episode ON render_jobs (episode_id);

-- Phase 3 (Master Task Brief §26): analytics snapshots.
-- Time-series rows per clip+platform+window; old snapshots are NEVER
-- overwritten (append-only, so trend computation stays honest).
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id               INTEGER NOT NULL,
  platform              TEXT NOT NULL DEFAULT 'youtube',
  snapshot_window_hours INTEGER NOT NULL,   -- 24 | 72 | 168 | 672
  captured_at           TEXT NOT NULL,
  views                 INTEGER NOT NULL DEFAULT 0,
  viewed_rate           REAL,               -- viewed vs swiped away
  avg_view_duration_sec REAL,
  avg_percentage_viewed REAL,
  retention_1s          REAL,
  retention_3s          REAL,
  retention_5s          REAL,
  retention_10s         REAL,
  likes                 INTEGER NOT NULL DEFAULT 0,
  comments              INTEGER NOT NULL DEFAULT 0,
  shares                INTEGER NOT NULL DEFAULT 0,
  subscriber_gain       INTEGER NOT NULL DEFAULT 0,
  traffic_source        TEXT,
  top_country           TEXT,
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_clip ON analytics_snapshots (clip_id, snapshot_window_hours, captured_at);

-- Phase 3 (Master Task Brief §30): episode metric snapshots for trend/evergreen/
-- breakout scoring. Append-only, per capture.
CREATE TABLE IF NOT EXISTS episode_metric_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id      TEXT NOT NULL,
  view_count    INTEGER,
  like_count    INTEGER,
  comment_count INTEGER,
  captured_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episode_metric_snapshots_video ON episode_metric_snapshots (video_id, captured_at);

-- Phase 3 (Master Task Brief §28): per-destination-channel scoring profiles.
CREATE TABLE IF NOT EXISTS channel_profiles (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id            TEXT NOT NULL UNIQUE,
  name                  TEXT,
  preferred_duration_sec TEXT,     -- JSON array, e.g. "[28,42]"
  strong_categories     TEXT,      -- JSON array
  weak_categories       TEXT,      -- JSON array
  preferred_hook_types  TEXT,      -- JSON array
  target_markets        TEXT,      -- JSON array
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Phase 3 (Master Task Brief §32): semantic embeddings for dedup.
-- vector is stored as JSON float array (SQLite has no native vector type).
CREATE TABLE IF NOT EXISTS content_embeddings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id      INTEGER NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'clip',  -- clip|core_claim|hook|payoff
  text         TEXT,
  vector       TEXT,                          -- JSON float[]
  model        TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_embeddings_clip ON content_embeddings (clip_id);

-- Phase 3 (Master Task Brief §35): content calendar entries (scheduled posts).
CREATE TABLE IF NOT EXISTS content_calendar (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id      INTEGER NOT NULL,
  scheduled_at TEXT NOT NULL,      -- ISO with explicit timezone offset
  target_market TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled|paused|published|cancelled
  slot_label   TEXT,               -- e.g. "Monday"
  reason       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_calendar_clip ON content_calendar (clip_id);
CREATE INDEX IF NOT EXISTS idx_content_calendar_at ON content_calendar (scheduled_at);

-- Phase 3 (Master Task Brief §33): portfolio planning suggestions.
CREATE TABLE IF NOT EXISTS portfolio_suggestions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  week         TEXT NOT NULL,      -- "2026-W32"
  clip_id      INTEGER NOT NULL,
  slot         TEXT,               -- "Monday"
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'suggested',  -- suggested|approved|rejected
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portfolio_suggestions_week ON portfolio_suggestions (week);

-- Phase 3 (Master Task Brief §29): market fit scores per clip.
CREATE TABLE IF NOT EXISTS market_fit_scores (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id            INTEGER NOT NULL,
  market             TEXT NOT NULL,
  score              REAL NOT NULL,
  recommended_market TEXT NOT NULL,
  reasons            TEXT,           -- JSON array
  computed_at        TEXT NOT NULL,
  UNIQUE (clip_id, market)
);

CREATE INDEX IF NOT EXISTS idx_market_fit_clip ON market_fit_scores (clip_id);

-- Phase 3 (Master Task Brief §31): comment mining signals.
CREATE TABLE IF NOT EXISTS comment_signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id     TEXT NOT NULL,
  clip_id      INTEGER,
  kind         TEXT NOT NULL,   -- timestamp_mention|repeated_question|controversial_claim|audience_language|objection|follow_up_topic|quoted_statement
  payload      TEXT NOT NULL,   -- JSON (e.g. {time_sec, text, count})
  confidence   REAL NOT NULL DEFAULT 0.5,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comment_signals_video ON comment_signals (video_id, kind);

-- Phase 4 (Master Task Brief §36): clip metadata/preview variants.
CREATE TABLE IF NOT EXISTS clip_variants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id      INTEGER NOT NULL,
  variant_key  TEXT NOT NULL,   -- hook_a|hook_b|hook_c
  hook         TEXT,
  title        TEXT,
  caption_emphasis TEXT,
  layout_preference TEXT,
  duration_delta_sec REAL,
  status       TEXT NOT NULL DEFAULT 'generated',  -- generated|previewed|selected|published|rejected
  preview_job_id TEXT,
  preview_url  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (clip_id, variant_key)
);

CREATE INDEX IF NOT EXISTS idx_clip_variants_clip ON clip_variants (clip_id);

-- Phase 4 (Master Task Brief §37): cost ledger.
-- cost_type distinguishes estimate vs actual (brief: never mix without the
-- field that separates them).
CREATE TABLE IF NOT EXISTS cost_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER,
  clip_id      INTEGER,
  category     TEXT NOT NULL,   -- llm|youtube_quota|transcript_vendor|render|storage|publish_api|gpu_estimate
  cost_type    TEXT NOT NULL DEFAULT 'estimate',  -- estimate|actual
  amount_usd   REAL NOT NULL,
  units        TEXT,            -- e.g. "tokens", "requests", "minutes", "MB"
  quantity     REAL,
  note         TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_ledger_run ON cost_ledger (run_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_clip ON cost_ledger (clip_id);
`;
