-- Board of Advisors. Multi-agent strategic council that lives in ops.
-- See BOARD_PLAN.md at the repo root for the design doc.
--
-- Topology (one session run):
--   board_sessions (1) -> board_cruxes  (N)
--                      -> board_messages (N)
--                      -> board_positions (N)
--                      -> board_decisions (1, on close)
--
-- All tables service-role only. No tenant_id anywhere. Same posture as the
-- rest of ops.* (competitors, incidents, decisions, etc).

-- Advisors --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.advisors (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  emoji        TEXT NOT NULL,
  title        TEXT NOT NULL,
  role_kind    TEXT NOT NULL CHECK (role_kind IN ('expert', 'challenger', 'chair')),
  expertise    TEXT[] NOT NULL DEFAULT '{}',
  description  TEXT NOT NULL DEFAULT '',
  knowledge_id UUID REFERENCES ops.knowledge_docs(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_advisors_active_idx
  ON ops.advisors (status, sort_order) WHERE status = 'active';

-- Sessions --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.board_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  topic           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'awaiting_review',
                                    'accepted', 'edited', 'rejected',
                                    'revised', 'failed')),
  advisor_ids     UUID[] NOT NULL,
  -- Per-call overrides. Default null means use board engine defaults
  -- (Anthropic Sonnet for advisors and chair). Set provider='openrouter'
  -- + model='moonshotai/kimi-k2-thinking' to A/B Kimi.
  provider_override TEXT,
  model_override    TEXT,
  budget_cents    INT NOT NULL DEFAULT 500,           -- default $5 cap
  spent_cents     INT NOT NULL DEFAULT 0,
  call_count      INT NOT NULL DEFAULT 0,
  context_snapshot JSONB,                              -- live ops state at session start
  error_message   TEXT,
  created_by_admin_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_key_id        UUID REFERENCES ops.api_keys(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  reviewed_at     TIMESTAMPTZ,
  overall_rating  SMALLINT CHECK (overall_rating BETWEEN 1 AND 5),
  review_notes    TEXT
);

CREATE INDEX IF NOT EXISTS ops_board_sessions_status_idx
  ON ops.board_sessions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ops_board_sessions_created_idx
  ON ops.board_sessions (created_at DESC);

-- Cruxes (live disagreements identified by the chair) ------------------

CREATE TABLE IF NOT EXISTS ops.board_cruxes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES ops.board_sessions(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'resolved', 'deadlock', 'dropped')),
  resolution_summary  TEXT,
  sort_order          INT NOT NULL DEFAULT 0,
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ops_board_cruxes_session_idx
  ON ops.board_cruxes (session_id, sort_order);

-- Messages (every utterance, every chair turn) -------------------------

CREATE TABLE IF NOT EXISTS ops.board_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES ops.board_sessions(id) ON DELETE CASCADE,
  advisor_id      UUID REFERENCES ops.advisors(id),       -- null for system / chair-internal
  crux_id         UUID REFERENCES ops.board_cruxes(id),
  turn_kind       TEXT NOT NULL
                  CHECK (turn_kind IN ('opening', 'exchange', 'challenge',
                                       'poll', 'chair_turn', 'final_position',
                                       'synthesis', 'system')),
  addressed_to    UUID REFERENCES ops.advisors(id),
  content         TEXT NOT NULL,
  payload         JSONB,                                  -- structured fields (chair actions, positions)
  new_information BOOLEAN,                                -- chair self-assessment for drift detection
  provider        TEXT,
  model           TEXT,
  prompt_tokens   INT,
  completion_tokens INT,
  cost_cents      INT,
  latency_ms      INT,
  advisor_rating  SMALLINT CHECK (advisor_rating BETWEEN 1 AND 5),
  review_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_board_messages_session_idx
  ON ops.board_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS ops_board_messages_advisor_idx
  ON ops.board_messages (advisor_id) WHERE advisor_id IS NOT NULL;

-- Positions (structured per-advisor final stances) ---------------------

CREATE TABLE IF NOT EXISTS ops.board_positions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID NOT NULL REFERENCES ops.board_sessions(id) ON DELETE CASCADE,
  advisor_id           UUID NOT NULL REFERENCES ops.advisors(id),
  crux_id              UUID REFERENCES ops.board_cruxes(id),       -- null = overall
  stance               TEXT NOT NULL,
  confidence           SMALLINT NOT NULL CHECK (confidence BETWEEN 1 AND 5),
  rationale            TEXT NOT NULL,
  shifted_from_opening BOOLEAN NOT NULL DEFAULT FALSE,
  emitted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- (session, advisor, crux) is unique. Postgres treats NULLs as distinct
  -- by default, so multiple `crux_id IS NULL` rows can coexist; a partial
  -- unique index covers the overall case explicitly.
  UNIQUE (session_id, advisor_id, crux_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ops_board_positions_overall_unique
  ON ops.board_positions (session_id, advisor_id) WHERE crux_id IS NULL;
CREATE INDEX IF NOT EXISTS ops_board_positions_advisor_idx
  ON ops.board_positions (advisor_id);

-- Decisions (chair synthesis + credit attribution + outcome) -----------

CREATE TABLE IF NOT EXISTS ops.board_decisions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               UUID NOT NULL UNIQUE REFERENCES ops.board_sessions(id) ON DELETE CASCADE,
  decision_text            TEXT NOT NULL,
  reasoning                TEXT NOT NULL,
  feedback_loop_check      TEXT NOT NULL,                -- mandatory close-the-loop signal
  action_items             JSONB NOT NULL DEFAULT '[]'::jsonb,
  dissenting_views         TEXT,
  chair_overrode_majority  BOOLEAN NOT NULL DEFAULT FALSE,
  chair_disagreement_note  TEXT,
  credited_advisor_ids     UUID[] NOT NULL DEFAULT '{}',
  overruled_advisor_ids    UUID[] NOT NULL DEFAULT '{}',
  overrule_reasons         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- advisor_id -> one-line reason
  status                   TEXT NOT NULL DEFAULT 'proposed'
                           CHECK (status IN ('proposed', 'accepted', 'edited', 'rejected')),
  edited_decision_text     TEXT,
  edited_action_items      JSONB,
  rejected_reason          TEXT,
  outcome                  TEXT NOT NULL DEFAULT 'pending'
                           CHECK (outcome IN ('pending', 'proven_right',
                                              'proven_wrong', 'obsolete')),
  outcome_marked_at        TIMESTAMPTZ,
  outcome_notes            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at              TIMESTAMPTZ,
  promoted_at              TIMESTAMPTZ,                  -- when sinks fired
  links                    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ops_board_decisions_status_idx
  ON ops.board_decisions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ops_board_decisions_outcome_idx
  ON ops.board_decisions (outcome, accepted_at DESC) WHERE status IN ('accepted', 'edited');

-- Stats view (computed on demand; volume is low) -----------------------

CREATE OR REPLACE VIEW ops.advisor_stats AS
SELECT
  a.id                                                                    AS advisor_id,
  a.slug,
  a.name,
  a.role_kind,
  a.status,
  COUNT(DISTINCT p.session_id)                                            AS sessions,
  COUNT(p.id)                                                             AS positions_taken,
  COUNT(p.id) FILTER (WHERE p.shifted_from_opening)                       AS concessions,
  COUNT(d.id) FILTER (WHERE a.id = ANY(d.credited_advisor_ids))           AS credited,
  COUNT(d.id) FILTER (WHERE a.id = ANY(d.overruled_advisor_ids))          AS overruled,
  COUNT(d.id) FILTER (WHERE d.outcome = 'proven_right'
                            AND a.id = ANY(d.credited_advisor_ids))       AS proven_right_credit,
  COUNT(d.id) FILTER (WHERE d.outcome = 'proven_wrong'
                            AND a.id = ANY(d.credited_advisor_ids))       AS proven_wrong_credit,
  COUNT(d.id) FILTER (WHERE d.outcome = 'proven_right'
                            AND a.id = ANY(d.overruled_advisor_ids))      AS overruled_but_right,
  AVG(m.advisor_rating) FILTER (WHERE m.advisor_rating IS NOT NULL)       AS avg_human_rating
FROM ops.advisors a
LEFT JOIN ops.board_positions p ON p.advisor_id = a.id
LEFT JOIN ops.board_decisions d ON d.session_id = p.session_id
LEFT JOIN ops.board_messages  m ON m.advisor_id = a.id
GROUP BY a.id, a.slug, a.name, a.role_kind, a.status;

-- updated_at triggers --------------------------------------------------

CREATE OR REPLACE FUNCTION ops.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ops_advisors_touch ON ops.advisors;
CREATE TRIGGER ops_advisors_touch
  BEFORE UPDATE ON ops.advisors
  FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

-- RLS + grants ---------------------------------------------------------

ALTER TABLE ops.advisors        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.board_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.board_cruxes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.board_messages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.board_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.board_decisions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ops.advisors, ops.board_sessions, ops.board_cruxes,
     ops.board_messages, ops.board_positions, ops.board_decisions
  TO service_role;

GRANT SELECT ON ops.advisor_stats TO service_role;

-- New scopes for ops.api_keys (referenced in route handlers + plan):
--   read:board, write:board, write:board:run, write:board:review
-- No table change required; scopes are validated against the array column
-- in keys.ts.
