ALTER TABLE ops.worklog_entries
  ADD COLUMN IF NOT EXISTS related_type TEXT,
  ADD COLUMN IF NOT EXISTS related_id   TEXT;
CREATE INDEX IF NOT EXISTS ops_worklog_related_idx
  ON ops.worklog_entries (related_type, related_id)
  WHERE related_type IS NOT NULL;
