-- Sizing + helpful status view for launch-progress dashboard.
ALTER TABLE ops.kanban_cards
  ADD COLUMN IF NOT EXISTS size_points INT
  CHECK (size_points IN (1, 2, 3, 5, 8, 13, 21));

CREATE INDEX IF NOT EXISTS ops_kanban_cards_size_idx
  ON ops.kanban_cards (size_points) WHERE archived_at IS NULL;

-- Helpful view for launch progress math
CREATE OR REPLACE VIEW ops.kanban_card_status AS
SELECT
  id, board_id, title, column_key, tags, size_points, priority, assignee,
  blocked_by, done_at, created_at, updated_at,
  'launch-blocker' = ANY(tags) AS is_launch_blocker,
  column_key = 'done' AS is_done,
  column_key = 'doing' AND done_at IS NULL AND updated_at < now() - interval '14 days' AS is_stuck
FROM ops.kanban_cards
WHERE archived_at IS NULL;
