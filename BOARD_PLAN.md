# Board of Advisors — HeyHenry Ops

<!-- STATUS: Phase 0 (foundation) — NOT STARTED -->

A multi-agent strategic board that lives inside `ops.heyhenry.io`, advises on
HeyHenry strategy, and learns from feedback over time. Lineage: ported from the
HenryOS Board of Advisors, redesigned to fix the reasons that one stopped
getting used.

## What this is

A structured way to convene a council of LLM-backed personas (Pricing, GTM,
Customer Success, Trust & Compliance, Surefooted Architect, Unit Economics,
Devil's Advocate, plus a Jonathan-imprinted Chairperson) to debate a strategic
question, resolve the actual disagreements, and produce a decision that lands
in a review queue for human rating before any downstream action is taken.

It is not a chatbot. It is a **structured decision factory** with a learning
loop: human ratings tune advisor prompts, and long-horizon outcome marking
attributes credit to whoever turned out to be right.

## Why

The HenryOS version had the right architectural bones (personas, vault-backed
skill files, three-phase debate, chairperson synthesis, websocket live UI) but
was rarely used in practice. Three reasons:

1. **Advisors reasoned in a vacuum.** They got the topic blob and nothing
   about the actual state of the business.
2. **Output landed nowhere.** A transcript and a synthesis lived in a JSON
   file. No decisions table, no kanban cards, no roadmap nudge. Easy to
   ignore.
3. **The "discussion" was shallow.** Each advisor spoke once, three reacted
   briefly, the chair decided. Disagreements were stated, not resolved.

This redesign addresses all three:

1. Advisors automatically read live ops state (decisions, kanban, ideas,
   roadmap, incidents, recent worklog) before responding.
2. Synthesis lands in a review queue. It only writes to `ops.decisions` /
   kanban / roadmap on explicit human acceptance, and ratings + outcomes
   feed back into future prompts.
3. The chair drives a dynamic agenda of explicit cruxes. Advisors exchange,
   challenge, concede, or stand ground. Each crux is resolved before the
   chair moves on.

## Strategic posture (applies to every advisor)

A shared preamble lives above every persona definition. Surefooted speed
toward 10k tenants is a frame, not a role.

> **Posture.** You are advising on a vertical SaaS growing toward 10,000
> contractor tenants. Reason from that future, not today's customer count.
> Reject the expedient choice that creates migration pain, trust debt, or a
> scaling cliff. Reject the paranoid choice that delays a shipment we are
> confident about. The standard is surefooted speed: move fast on what we are
> sure of, name the sources of uncertainty plainly when we are not. If you
> would give different advice at 30 customers vs. 3,000, say so and recommend
> the path that does not require a re-do.

## Boundary decisions (non-negotiable)

1. **Lives in `ops.*` Supabase schema**, no `tenant_id` anywhere. Same RLS
   posture as the rest of ops (service-role only). Zero overlap with
   contractor data.
2. **Dual-auth API**: ops admin session (humans) AND HMAC API key (agents).
   Same pattern as `competitors`, `incidents`, etc.
3. **No auto-write to anything.** Synthesis is a *proposal*. Kanban, decisions,
   and roadmap writes happen only on explicit human acceptance.
4. **Chair holds the reins.** No advisor voting, no consensus rules. Advisors
   record structured final positions; the Chair decides and must explicitly
   credit or overrule each one.
5. **Imprint on Chair only.** The other advisors are independent external
   counsel. Loading the imprint into all of them would collapse the
   diversity-of-perspective that makes multi-agent debate work.
6. **Cost cap per session, fail-closed.** Default $5. Sessions that hit the
   cap halt and synthesize from what they have.

## Architecture

### Where it lives

- **DB:** `ops.*` schema, single migration (next available number,
  `0179_ops_board.sql`).
- **Server services:** `ops/src/server/ops-services/board.ts` (CRUD, pure
  functions over service-role Supabase) and
  `ops/src/server/ops-services/board-discussion.ts` (the engine).
- **Routes:** `ops/src/app/api/ops/board/*` (REST, App Router handlers).
- **MCP:** new tools added to `mcp/ops` exposing the board API to Routines and
  Managed Agents.
- **UI:** `/ops/board` (sessions list, advisor roster, leaderboard) and
  `/ops/board/sessions/[id]` (live transcript, position grid, review actions).
  Live updates via Supabase Realtime on `ops.board_messages`. No websocket
  service required.

### Schema

Migration `0179_ops_board.sql`. RLS enabled on every table, service-role only.

```sql
-- Advisors
create table ops.advisors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text not null,
  title text not null,
  role_kind text not null check (role_kind in ('expert','challenger','chair')),
  expertise text[] not null default '{}',
  description text not null default '',
  knowledge_id uuid references ops.knowledge(id),  -- skill doc, optional
  status text not null default 'active' check (status in ('active','retired')),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sessions
create table ops.board_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  topic text not null,
  status text not null default 'pending' check (status in
    ('pending','running','awaiting_review','accepted','edited','rejected','revised','failed')),
  advisor_ids uuid[] not null,
  budget_cents int not null default 500,           -- default $5
  spent_cents int not null default 0,
  call_count int not null default 0,
  context_snapshot jsonb,                          -- ops state at session start
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  reviewed_at timestamptz,
  overall_rating smallint check (overall_rating between 1 and 5),
  review_notes text
);

-- Cruxes (the live disagreements identified by the chair)
create table ops.board_cruxes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references ops.board_sessions(id) on delete cascade,
  label text not null,
  status text not null default 'open' check (status in ('open','resolved','deadlock','dropped')),
  resolution_summary text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

-- Messages (every utterance, every chair turn)
create table ops.board_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references ops.board_sessions(id) on delete cascade,
  advisor_id uuid references ops.advisors(id),     -- null for system / chair-internal
  crux_id uuid references ops.board_cruxes(id),
  turn_kind text not null check (turn_kind in
    ('opening','exchange','challenge','poll','chair_turn','final_position','synthesis')),
  addressed_to uuid references ops.advisors(id),
  content text not null,
  payload jsonb,                                   -- structured fields (positions, chair actions)
  new_information bool,                            -- chair self-assessment for drift detection
  prompt_tokens int,
  completion_tokens int,
  cost_cents int,
  advisor_rating smallint check (advisor_rating between 1 and 5),
  review_note text,
  created_at timestamptz not null default now()
);

-- Final per-advisor positions (overall + per-crux)
create table ops.board_positions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references ops.board_sessions(id) on delete cascade,
  advisor_id uuid not null references ops.advisors(id),
  crux_id uuid references ops.board_cruxes(id),    -- null = overall
  stance text not null,
  confidence smallint not null check (confidence between 1 and 5),
  rationale text not null,
  shifted_from_opening bool not null default false,
  emitted_at timestamptz not null default now(),
  unique (session_id, advisor_id, crux_id)
);

-- Decisions (the chair's synthesis, plus credit attribution and outcome)
create table ops.board_decisions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references ops.board_sessions(id) on delete cascade,
  decision_text text not null,
  reasoning text not null,
  feedback_loop_check text not null,               -- the close-the-loop signal
  action_items jsonb not null default '[]',
  dissenting_views text,
  chair_overrode_majority bool not null default false,
  credited_advisor_ids uuid[] not null default '{}',
  overruled_advisor_ids uuid[] not null default '{}',
  overrule_reasons jsonb not null default '{}',    -- advisor_id -> one-line reason
  status text not null default 'proposed' check (status in
    ('proposed','accepted','edited','rejected')),
  edited_decision_text text,
  edited_action_items jsonb,
  outcome text not null default 'pending' check (outcome in
    ('pending','proven_right','proven_wrong','obsolete')),
  outcome_marked_at timestamptz,
  outcome_notes text,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  promoted_at timestamptz,                         -- when sinks fired
  links jsonb not null default '{}'                -- { decision_id, kanban_card_ids[], roadmap_id }
);

-- Indexes
create index on ops.board_messages (session_id, created_at);
create index on ops.board_messages (advisor_id);
create index on ops.board_positions (advisor_id);
create index on ops.board_decisions (status);
create index on ops.board_decisions (outcome);
create index on ops.advisors (status, sort_order);
```

Advisor stats are a **view** computed on-demand. Not a materialized view at
this volume.

```sql
create view ops.advisor_stats as
select
  a.id as advisor_id,
  a.name,
  a.role_kind,
  count(distinct p.session_id) as sessions,
  count(p.id) as positions_taken,
  count(p.id) filter (where p.shifted_from_opening) as concessions,
  count(*) filter (where d.id is not null and a.id = any(d.credited_advisor_ids)) as credited,
  count(*) filter (where d.id is not null and a.id = any(d.overruled_advisor_ids)) as overruled,
  count(*) filter (where d.outcome = 'proven_right' and a.id = any(d.credited_advisor_ids)) as proven_right_credit,
  count(*) filter (where d.outcome = 'proven_wrong' and a.id = any(d.credited_advisor_ids)) as proven_wrong_credit,
  count(*) filter (where d.outcome = 'proven_right' and a.id = any(d.overruled_advisor_ids)) as overruled_but_right,
  avg(m.advisor_rating) filter (where m.advisor_rating is not null) as avg_human_rating
from ops.advisors a
left join ops.board_positions p on p.advisor_id = a.id
left join ops.board_decisions d on d.session_id = p.session_id
left join ops.board_messages m on m.advisor_id = a.id
group by a.id, a.name, a.role_kind;
```

### API surface

All routes under `/api/ops/board/*`, dual-auth (ops admin session OR HMAC API
key with appropriate scope).

| Route | Method | Scope | Purpose |
|---|---|---|---|
| `/board/advisors` | GET, POST | `read:board`, `write:board` | List, create |
| `/board/advisors/:id` | GET, PATCH, DELETE | `read:board`, `write:board` | CRUD |
| `/board/advisors/:id/stats` | GET | `read:board` | Advisor stats view, scoped |
| `/board/sessions` | GET, POST | `read:board`, `write:board` | List, create |
| `/board/sessions/:id` | GET | `read:board` | Full session with messages, positions, decision |
| `/board/sessions/:id/run` | POST | `write:board:run` | Kick off discussion (background, returns 202) |
| `/board/sessions/:id/intervene` | POST | `write:board:run` | Mid-session human nudge to chair |
| `/board/sessions/:id/review` | POST | `write:board:review` | Submit rating + per-advisor ratings + notes |
| `/board/sessions/:id/decision/accept` | POST | `write:board:review` | Promote decision, fire action sinks |
| `/board/sessions/:id/decision/edit` | POST | `write:board:review` | Save edited decision text + action items |
| `/board/sessions/:id/decision/reject` | POST | `write:board:review` | Mark rejected with reason |
| `/board/sessions/:id/rerun` | POST | `write:board:run` | Re-convene with revised topic |
| `/board/decisions` | GET | `read:board` | All decisions, filterable by status/outcome |
| `/board/decisions/:id/outcome` | POST | `write:board:review` | Mark proven right / wrong / obsolete |
| `/board/leaderboard` | GET | `read:board` | Advisor stats, sorted views |

### MCP tools (mcp-ops package)

Wrap each route in a tool. Same HMAC-signing pattern as existing ops MCP. Tool
descriptions written for agent discoverability.

- `board_advisors_list`, `board_advisors_get`
- `board_sessions_list`, `board_session_create`, `board_session_get`,
  `board_session_run`
- `board_decision_get`, `board_decisions_list`
- `board_advisor_stats`, `board_leaderboard`

Routines and Managed Agents can convene the board the same way humans can.
Useful for: an incident-triage agent that opens a board session when a
high-severity incident lands; a weekly strategic standup Routine.

### UI

- `/ops/board` — sessions list (filter by status, outcome), advisor roster,
  leaderboard tab.
- `/ops/board/new` — convene form: title, topic, advisor picker (with quick
  presets like "pricing", "GTM", "compliance"), budget override.
- `/ops/board/sessions/[id]` — live transcript, position grid (advisor x crux
  matrix), cruxes panel (open/resolved), decision panel with review actions.
  Supabase Realtime subscription on `ops.board_messages` for streaming.
- `/ops/board/advisors/[id]` — records page: stats, recent positions, recent
  ratings, recent decisions credited/overruled.
- `/ops/board/decisions` — proposed queue + outcome-marking UI for past
  accepted decisions.

## The Advisors

### Roster (initial)

| Emoji | Name | Role | Expertise |
|---|---|---|---|
| 🏗️ | Vertical SaaS Strategist | expert | what to ship, where the moat is, sequencing |
| 🤝 | Founder-Led Sales | expert | landing design partners 2 to 10, sales motion |
| 💵 | Pricing & Packaging | expert | seat vs job, free trial, design partner pricing |
| 🎯 | Customer Success | expert | activation, churn risk, real usage patterns |
| 🔒 | Trust & Compliance | expert | CASL, MFA, RLS, data residency, SOC2 path |
| 📐 | Surefooted Architect | expert | schema, scale at 10k tenants, migration cost |
| 💰 | Unit Economics | expert | CAC, LTV, burn vs runway, pricing math |
| 😈 | Devil's Advocate | challenger | stress-tests every recommendation, rejected by default in role-aware metrics |
| 🎩 | Strategic Chair | chair | Jonathan-imprinted, holds the reins |

Skill docs live in `ops.knowledge` (the existing knowledge service). Reuse,
not a new vault. The Chair's skill doc is the Jonathan AI Imprint, copied from
HenryOS at session-1 setup.

### Opening prompt structure (every advisor)

```
[Posture block — shared preamble, see above]

[Persona block]
You are {emoji} {name}, {title}.
Expertise: {expertise}
Role: {description}

[Skill content, if knowledge_id present]

[Live context block — assembled at session start]
## Current state of HeyHenry
- Active tenants: {n}, primary user: {jvd or other}
- Recent decisions (last 30d): {bullet list}
- Open kanban: {high-priority cards}
- Roadmap status: {phase, next milestones}
- Open incidents: {count, severities}
- Recent worklog (last 7d): {summary}

[Track record block — appended after first session]
## Your record
Last 10 sessions: {credited X, overruled Y, conceded Z}
Outcomes (where marked): {proven_right A, proven_wrong B}
Highest-rated message themes: {...}
Lowest-rated message themes: {...}
```

The track record block is the self-tuning loop. Advisors literally see their
own report card. Same applies to the Chair.

### Chairperson specifics

The Chair carries the full Jonathan AI Imprint (~16KB) plus a chair role
preamble. The imprint shapes the *frame* of decision-making (feedback-loop
dependency, BS detector, confession over spin, fast but surefooted, won't
compromise quality). It is not used to mimic voice for advisors.

Chair output contract is structured and parseable:

```
## Decision
[1 to 2 sentences, decisive, no hedging]

## Reasoning
[3 to 6 sentences, must cite specific advisor arguments accepted or rejected]

## Action Items
[2 to 5 bullets, each one phrased as a kanban-ready task]

## Feedback-Loop Check
[How will we know within N days whether this decision is working?
What is the close-the-loop signal? This section is mandatory. The imprint
flagged feedback-loop dependency as the failure mode that stalls Jonathan.]

## Dissenting Views
[Brief acknowledgment of strong counterarguments not adopted]

## Where I Disagree With My Board
[Only if chair_overrode_majority is true. One paragraph naming who was
overruled and why.]

## Credits and Overrules (structured, JSON tail)
{
  "credited_advisor_ids": ["..."],
  "overruled_advisor_ids": ["..."],
  "overrule_reasons": { "<advisor_id>": "one-line reason" }
}
```

## Discussion engine

Replace the HenryOS fixed Round 1 / Round 2 / Synthesis with a chair-driven
loop. The chair is called repeatedly and decides what happens next. Bounded
by budget, not turn count.

### Phase A: opening statements (parallel)

Every selected advisor responds independently to the topic with the live
context block injected. Same shape as the HenryOS Round 1. This gives the
chair raw material.

### Phase B: crux extraction (chair turn 0)

Chair reads all opening statements and emits a structured list:

```json
{
  "consensus": ["everyone agrees on X", "everyone agrees on Y"],
  "cruxes": [
    { "id": "pricing-model", "label": "Per-seat vs per-job", "advisors": ["pricing","unit-econ"] },
    { "id": "gtm-motion", "label": "Founder-led vs PLG self-serve", "advisors": ["gtm","cs"] }
  ]
}
```

Cruxes get persisted in `ops.board_cruxes` with `status='open'`.

### Phase C: crux resolution loop

Chair is called in a loop. Each call returns one structured action:

```json
{
  "action": "exchange" | "challenge" | "poll" | "next_crux" | "close",
  "crux_id": "pricing-model",
  "advisor_ids": ["pricing", "unit-econ"],
  "prompt": "...",
  "reasoning": "why this advances the discussion",
  "new_information": true
}
```

Action handlers:

- **exchange**: call advisor A, feed response to advisor B, get rebuttal. Up
  to 3 turns or until one concedes/refines. Each turn gets `crux_id` set on
  the message.
- **challenge**: call Devil's Advocate against a specific claim. Chair
  invokes at least one challenge per crux.
- **poll**: ask every advisor a yes/no on a crux. Counts disagreement.
- **next_crux**: current crux closed (resolved, deadlock, or dropped). Chair
  fills `resolution_summary`. Loop continues with next open crux.
- **close**: all cruxes closed or budget hit. Triggers Phase D.

### Bounds (so it does not run forever)

Not turn caps. Budget caps plus drift detectors:

- **Hard cost cap per session.** Default $5. Chair sees `budget_remaining` on
  every turn and is instructed to triage. At 80% spent, chair is told to
  start closing cruxes.
- **Novelty check.** Every chair turn tags `new_information: bool`. Two
  consecutive turns with `false` triggers auto-close.
- **Per-crux soft nudge.** At 5 exchanges on one crux, chair is told
  "resolve, deadlock, or move on."
- **Repetition detector.** Cosine-similarity on advisor messages within a
  session. Too-similar response triggers a nudge in the chair's next prompt.

### Phase D: final positions plus chair decision

1. **Final positions (parallel).** Every selected advisor is called once
   more with the full transcript and emits a structured final position
   (overall + per-crux stance, confidence 1 to 5, rationale,
   shifted_from_opening flag). Persisted in `ops.board_positions`.

2. **Chair synthesis.** Chair is called with full transcript + position grid
   + budget remaining. Output follows the contract above. Persisted in
   `ops.board_decisions` with `status='proposed'`. **No downstream writes
   yet.**

3. Session moves to `awaiting_review`.

### Mid-session human intervention

`POST /board/sessions/:id/intervene { instruction: "..." }` injects a
human note into the chair's next prompt. Cheap to add, very high value
when learning what good chair behavior looks like. Examples: "ignore the
pricing crux", "push DA harder on GTM", "wrap this up."

## Decision review loop

The single biggest UX shift from HenryOS. No auto-write to anything until a
human accepts.

### Review UI (`/ops/board/sessions/[id]`)

Once `status='awaiting_review'`:

1. Read the synthesis, positions, and transcript.
2. Rate the synthesis (1 to 5 stars).
3. Rate each advisor's contribution (per-message thumb or star).
4. Free-text notes (per-advisor and overall). These are training signal.
5. Choose one of four actions:
   - **Accept**: synthesis stands as-is. Status to `accepted`. Action sinks
     fire (next section).
   - **Edit & Accept**: open the decision text and action items in an inline
     editor, save, then accept. Status to `edited`. Edited content is what
     fires sinks. Original synthesis preserved for the record.
   - **Reject**: status to `rejected` with a required reason. No sinks.
   - **Re-run with revised topic**: status to `revised`. Opens a new session
     using the notes to rewrite the prompt. The original session stays in
     the record, linked.

### Action sinks (only on accept or edit-and-accept)

Idempotent on `from-board:<sessionId>` so re-accepts cannot double-spawn.

- **Decisions:** insert one row in `ops.decisions` (the existing decisions
  table). Linked back to the session.
- **Kanban:** create one card per `action_item` in the appropriate board.
  Tagged `from-board:<sessionId>` and `decision:<decisionId>`.
- **Roadmap (optional):** if the synthesis flags a strategic shift, prompt
  the human at accept time to pick a roadmap row to update or create.

`board_decisions.links` records the IDs that were created. `promoted_at`
timestamps the moment.

### Self-tuning loop

The combination of in-the-moment ratings plus long-horizon outcomes feeds
back into future sessions:

- Advisor track-record block (see prompt structure above) recomputed before
  each session. Aggregates last N session ratings + outcome attributions.
- Lowest-rated message themes are surfaced to the advisor as "patterns to
  avoid."
- For the chair: aggregated patterns of "decisions you made that turned out
  right" and "decisions you made that turned out wrong" go into every chair
  turn's system prompt.

## Performance records

### Stats view

`ops.advisor_stats` is computed on-demand from positions + decisions +
messages. UI surfaces it three ways:

- **Per-advisor records page** (`/ops/board/advisors/[id]`): the full table,
  recent positions, recent ratings, decisions where credited / overruled.
- **Leaderboard** (`/ops/board/decisions` tab): sortable by credited rate,
  proven-right contribution, avg human rating, etc.
- **In-session position grid**: advisor × crux matrix during and after a
  session.

### Role-aware framing

Flat overrule rate is misleading. Devil's Advocate is supposed to lose most
votes. The leaderboard renders role-aware:

- **Expert advisors:** high credited rate good, high overrule rate bad. Flag
  any expert with 3 sessions and zero credits.
- **Challengers (DA):** high overrule rate is expected. What matters is
  whether the chair's overrule reasoning is substantive. The
  `overrule_reasons` field exposes the one-liner per overrule, so dismissive
  vs. engaged overrules are visible.
- **Chair:** not rated against itself by the system, only by human review
  and by long-horizon outcome attribution.

### Outcome marking (the long-horizon loop)

Every accepted decision can be retroactively marked:

- `proven_right` (with notes)
- `proven_wrong` (with notes)
- `obsolete` (decision no longer relevant)

UI: `/ops/board/decisions` shows accepted decisions older than 30 days that
are still `pending`. One-click marker with a notes field.

This is the metric that compounds. Two payoffs:

1. Real learning signal. "Pricing & Packaging gave the winning idea on 4 of 7
   pricing decisions that beat baseline" beats any synthetic metric.
2. Chair self-correction. "Chair overruled Devil's Advocate 8 times. 5 of
   those overrules turned out wrong" is precisely the kind of feedback the
   Chair (with imprint) needs to recalibrate.

## Triggers (how sessions get convened)

Three modes, layered:

1. **On-demand (Slice 1).** Human clicks "Convene Board" in `/ops/board`,
   fills the form. Default trigger.
2. **Decision-inbox auto-trigger (Slice 3).** A kanban card tagged
   `needs-board` causes a Managed Agent to read the card, create a session
   with a rule-based advisor subset, and run it. Synthesis goes to the
   review queue (not back onto the card).
3. **Weekly strategic standup (Slice 4, deferred).** A Routine on Sundays
   reads last week's worklog, kanban deltas, revenue, and incidents.
   Convenes a board with an opinionated topic ("What should HeyHenry do
   this week?"). Defer until 1 to 3 are landing decisions you actually
   accept.

## Cost & safety

### Cost

| Session shape | LLM calls | Approx cost |
|---|---|---|
| Easy (1 to 2 cruxes, fast convergence) | 8 to 12 | $0.30 to $0.80 |
| Typical (3 to 4 cruxes, real debate) | 15 to 25 | $1 to $3 |
| Hard (4+ cruxes, heavy challenges) | 25 to 40 | $3 to $5 (cap) |

Daily use ceiling at the cap is roughly $150/mo. Real usage will be far
lower. The bottleneck is signal quality, not LLM spend.

### Safety

- Hard cost cap per session, fail-closed. Cap hit triggers `close` and a
  best-effort synthesis.
- Idempotent action sinks keyed on `from-board:<sessionId>`.
- All routes behind dual-auth (admin session or HMAC), same as the rest of
  ops.
- No tenant data ever read. Live context block reads `ops.*` only.
- Session and message rows are soft-immutable: edits go to
  `edited_decision_text` / `edited_action_items`, never overwriting the
  original synthesis. Original is the historical record.

## Phasing / slices

Ship in slices. Each slice is independently useful. Defer later slices
until earlier ones are landing decisions you actually accept.

### Slice 1 — Foundation (target: ~5 days)

**Goal:** convene a board on-demand, get a structured synthesis in the
review queue, no downstream writes.

- Migration `0179_ops_board.sql`.
- `ops-services/board.ts`: advisor/session/crux/message/position/decision
  CRUD, all pure functions over service-role Supabase.
- `ops-services/board-discussion.ts`: the engine. Phases A/B/C/D.
  Chair-orchestrated cruxes. Budget caps. Novelty check.
- Live context loader: parallel reads against existing ops services
  (decisions, kanban, ideas, roadmap, incidents, worklog).
- Routes: advisors CRUD, sessions CRUD, run, get. Dual-auth.
- Knowledge docs: import the 8 advisor skills + the Jonathan AI Imprint
  into `ops.knowledge`.
- mcp-ops tools: `board_advisors_list`, `board_session_create`,
  `board_session_run`, `board_session_get`.
- UI: `/ops/board`, `/ops/board/new`, `/ops/board/sessions/[id]` (read-only
  transcript + position grid). Supabase Realtime stream.

**Verify:** convene a board on a real strategic question. Synthesis lands in
`ops.board_decisions` with `status='proposed'`. No kanban / decisions / roadmap
writes. Cost capped at $5.

### Slice 2 — Review loop and rating system (target: ~3 days)

**Goal:** rate, edit, accept, reject. Action sinks fire only on acceptance.

- Review UI: stars, per-advisor ratings, free-text notes, four actions.
- Edit-in-place editor for decision text + action items.
- Action sinks: decisions, kanban (idempotent on session id), optional
  roadmap.
- Rejection reason capture.

**Verify:** accept a decision, see kanban cards spawn. Edit-and-accept,
verify the edited content fires sinks. Reject with reason, verify nothing
fires.

### Slice 3 — Performance records (target: ~3 days)

**Goal:** see who is winning and losing, and tune accordingly.

- `ops.advisor_stats` view.
- `/ops/board/advisors/[id]` records page.
- Leaderboard tab on `/ops/board`.
- Self-tuning track-record block in advisor + chair prompts (recomputed at
  session start).
- mcp-ops tools: `board_advisor_stats`, `board_leaderboard`.

**Verify:** after 3 to 5 sessions, the records page shows real numbers.
Manually trigger a session and verify the track-record block appears in the
prompts.

### Slice 4 — Decision-inbox auto-trigger (target: ~2 days)

**Goal:** kanban tag triggers a board session automatically.

- Managed Agent that watches for `needs-board` tag adds, creates a session,
  runs it.
- Rule-based advisor subset selection by card tags (e.g., card tagged
  `pricing` brings in Pricing, Unit Econ, CS, plus Chair plus DA).
- Synthesis posted as a comment on the source card with a link to the
  review page.

**Verify:** tag a real card, watch the session run, review the synthesis,
accept it, verify spawned cards link back.

### Slice 5 — Outcome marking (target: ~2 days)

**Goal:** retroactive credit attribution closes the long-horizon loop.

- `/ops/board/decisions` queue of accepted-but-unmarked decisions older than
  30 days.
- One-click outcome marker with notes.
- Stats view picks up `proven_right_credit`, `proven_wrong_credit`,
  `overruled_but_right`.
- Chair prompt gets aggregated outcome history block.

**Verify:** mark 3 historical decisions, see chair prompt picks up the
patterns next session.

### Slice 6 — Weekly strategic standup (deferred)

**Goal:** the board speaks without being summoned.

Defer until Slices 1 to 5 are producing decisions you reliably accept.
A Sunday Routine reads worklog + kanban + revenue + incidents, opens a
session with the opinionated topic, posts the result to a digest. Easy
to add later.

## Open questions (decide before Slice 1)

1. **Model choice and provider.** HenryOS uses Claude Sonnet 4 via
   OpenRouter. HeyHenry already has Anthropic API access and Sentry-tagged
   spans for observability. Recommend: Anthropic API direct with prompt
   caching on the imprint and skill files (the imprint is ~4k tokens, gets
   reused on every chair turn, caching saves real money). Sonnet 4.6 for
   advisors and chair, Haiku 4.5 for chair extraction/orchestration turns
   that don't need depth.
2. **Initial advisor count.** 9 is what HenryOS shipped. Recommend starting
   with 5 (Pricing, GTM, CS, Architect, DA) plus Chair to keep first
   sessions tight, add the rest after Slice 3 records show real coverage
   gaps.
3. **Knowledge doc authorship.** Need 8 short skill docs (~1 to 3 KB each)
   plus the imprint. Imprint is already written. Skill docs to be drafted
   from existing AGENT_PLATFORM_PLAN.md, OPS_PLAN.md, and Jonathan's voice
   memos. Could be done by the chair on first run from the conversation
   that designed each role, then reviewed.
4. **Default budget.** $5 cap feels right for "real strategic decisions",
   but `/ops/board/new` should expose budget override (e.g., $1 for quick
   gut-checks).
5. **Realtime vs polling for streaming UI.** Supabase Realtime works on
   `ops.*` rows; ops already uses it elsewhere. Confirm the existing pattern
   (websocket vs Supabase channels) before Slice 1.

## Out of scope (explicitly)

- Live multi-turn chat with advisors. The HenryOS UI had it; it was not
  what got used. Async submit-topic-then-review is the durable mode.
- Voice or audio output. Text only.
- Tenant-facing surfaces. The board is a HeyHenry-the-business tool. Zero
  exposure to contractor users.
- Auto-acceptance rules. Even high-confidence, high-rated decisions go
  through the human review gate. The whole point is the feedback loop.
