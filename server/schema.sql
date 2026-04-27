CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  app_version TEXT,
  os_version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  point_count INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points (
  point_id TEXT PRIMARY KEY,
  batch_id INTEGER,
  device_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  local_sequence INTEGER NOT NULL,
  stream TEXT NOT NULL,
  event_date TEXT NOT NULL,
  received_at_device TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash_sha256 TEXT NOT NULL,
  payload_json_valid INTEGER NOT NULL,
  source_id TEXT,
  FOREIGN KEY (batch_id) REFERENCES batches(id)
);

CREATE INDEX IF NOT EXISTS idx_points_stream_event_date ON points(stream, event_date);
CREATE INDEX IF NOT EXISTS idx_points_device_sequence ON points(device_id, local_sequence);
CREATE INDEX IF NOT EXISTS idx_points_payload_hash ON points(payload_hash_sha256);

CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
