-- Ops kanban module: boards + cards + events.
--
-- Four seeded boards (Dev, Marketing, Research, Ops) cover the surfaces
-- Jonathan + agents actually touch. Cards live in fixed columns
-- (backlog / todo / doing / blocked / done) with explicit ordering so
-- MCP moves are deterministic. Events table is the audit trail — every
-- card mutation logs a row so agents can reconstruct history.
--
-- RLS is enabled with no policies: service-role key only. No direct
-- client reads; all access goes through ops admin UI or MCP tools.

CREATE TABLE ops.kanban_boards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  description text,
  sort_order  int NOT NULL DEFAULT 0,
  actor_type  text NOT NULL CHECK (actor_type IN ('human','agent','system')),
  actor_name  text NOT NULL,
  key_id      uuid,
  admin_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.kanban_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id        uuid NOT NULL REFERENCES ops.kanban_boards(id) ON DELETE CASCADE,
  column_key      text NOT NULL
                  CHECK (column_key IN ('backlog','todo','doing','blocked','done')),
  title           text NOT NULL,
  body            text,
  tags            text[] NOT NULL DEFAULT ARRAY[]::text[],
  due_date        date,
  priority        int CHECK (priority BETWEEN 1 AND 5),
  order_in_column int NOT NULL DEFAULT 0,
  assignee        text,
  suggested_agent text,
  blocked_by      uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  related_type    text,
  related_id      text,
  recurring_rule  text,
  recurring_parent_id uuid REFERENCES ops.kanban_cards(id) ON DELETE SET NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('human','agent','system')),
  actor_name      text NOT NULL,
  key_id          uuid,
  admin_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz,
  archived_at     timestamptz
);

CREATE INDEX ON ops.kanban_cards (board_id, column_key, order_in_column) WHERE archived_at IS NULL;
CREATE INDEX ON ops.kanban_cards (assignee) WHERE archived_at IS NULL AND column_key <> 'done';
CREATE INDEX ON ops.kanban_cards (due_date) WHERE archived_at IS NULL AND done_at IS NULL;
CREATE INDEX ON ops.kanban_cards USING gin (tags);

CREATE TABLE ops.kanban_card_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id     uuid NOT NULL REFERENCES ops.kanban_cards(id) ON DELETE CASCADE,
  event_type  text NOT NULL
              CHECK (event_type IN ('created','moved','claimed','released','assigned',
                                    'commented','blocked','unblocked','linked','archived',
                                    'recurring_spawned','edited','tagged')),
  body        text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type  text NOT NULL,
  actor_name  text NOT NULL,
  key_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ops.kanban_card_events (card_id, created_at DESC);

ALTER TABLE ops.kanban_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.kanban_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.kanban_card_events ENABLE ROW LEVEL SECURITY;

INSERT INTO ops.kanban_boards (name, slug, description, sort_order, actor_type, actor_name)
VALUES
  ('Dev',       'dev',       'Code tasks, bugs, refactors, infra',                 1, 'system', 'seed'),
  ('Marketing', 'marketing', 'Content, campaigns, SEO — graduated social drafts',  2, 'system', 'seed'),
  ('Research',  'research',  'Deep investigations — strategic questions',          3, 'system', 'seed'),
  ('Ops',       'ops',       'Legal, billing, partnerships, admin',                4, 'system', 'seed')
ON CONFLICT (slug) DO NOTHING;
