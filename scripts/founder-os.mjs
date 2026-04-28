import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

// Create the board
await sql`
  INSERT INTO ops.kanban_boards (name, slug, description, sort_order, actor_type, actor_name)
  VALUES ('Founder OS', 'founder-os',
          'Jonathan-side: HeyHenry sales CRM, prospect tracking, founder marketing, outreach cadences. NOT HeyHenry product dev — that lives on the dev board.',
          5, 'human', 'jonathan')
  ON CONFLICT (slug) DO NOTHING
`;
const [board] = await sql`SELECT id FROM ops.kanban_boards WHERE slug = 'founder-os'`;

const cards = [
  ['Schema + data model for Founder CRM', 8,
   "Tables (in app DB or ops? — decide first; lean ops since it's Jonathan-only): contacts, opportunities (deals), interactions (calls/emails/meetings/notes log), pipeline_stages. Contact has: name, email, phone, company, segment (gc / pressure-wash / other), source (where they came from), stage_id, owner. Opportunity has: contact_id, value_estimate, expected_close_date, current_stage, stage_history. Interaction has: contact_id, opportunity_id, kind (call/email/sms/meeting/note), summary, occurred_at, follow_up_due. Soft delete; full audit trail."],

  ['Contact list + detail page (CRM core)', 5,
   "List: filterable by stage, segment, owner, last-contacted-window. Detail page shows: contact info, full interaction timeline, linked opportunities, next-action card at top, quick-add interaction inline (no modal). Search across name + email + company. Tag system for grouping (e.g. tag='pilot-candidate', 'beta-feedback'). Mirrors the lead detail page pattern from HeyHenry but without the construction-specific fields."],

  ['Sales pipeline kanban — drag-drop deal stages', 5,
   "Visual pipeline: Lead → Qualified → Demo Booked → Proposal Sent → Won / Lost. Drag opportunity cards between columns. Each card shows: contact name, company, value, days in stage. Column totals (count + sum value). Click → opportunity detail. Stages configurable per tenant (just Jonathan for now)."],

  ['Follow-up tasks for prospects (reuse Tasks module)', 3,
   "Extend the existing tasks schema with a new scope='founder-contact' (or just use scope='lead' with a contact_id pointing to the founder CRM). Each follow-up has: contact, due_date, action ('Send proposal', 'Check in', 'Demo follow-up'), status. Surfaces in Owner command center 'Today' and 'Needs You' alongside HeyHenry tasks — single morning view. Henry can create via voice: 'remind me to follow up with Will Friday'."],

  ['Outreach email cadences (autoresponder integration)', 8,
   "Reuse the existing AR engine. New 'founder' AR scope (separate from HeyHenry tenant marketing). Cadences: Cold prospect (3 emails, 2/5/12 days), Demo follow-up (2 emails, 1/4 days), Stale opportunity (1 email at 14 days). Each contact can be enrolled/unenrolled. Open + click tracked per Resend webhook. UI to compose + edit cadences. Send via existing ops_email_send tool — Resend infrastructure already in place."],

  ['Marketing dashboard — pipeline + attribution + content', 5,
   "Single page /admin/marketing showing: pipeline value by stage (rollup of opportunities), conversion rate stage-to-stage (last 30/90 days), top sources (which channels brought contacts in), pending social_drafts ready to ship (from existing pain-points-research output), recent ai-tools-scout + business-scout findings tagged for marketing review. Connects existing ops surfaces into one view."],

  ['Founder daily briefing — what to do today', 3,
   "Morning summary (extends Henry's morning briefing pattern from Phase 4 of Tasks): contacts to follow up on today, opportunities going stale (>14 days no interaction), pipeline value movement vs last week, scouts' new ideas tagged sales/marketing. Delivered by same channel as the Henry nightly briefing once that's wired up. Pure addition — no new infra."],

  ['Henry tools for Founder CRM', 5,
   "Add Henry tools: list_contacts, get_contact, add_contact, log_interaction, update_opportunity_stage, list_opportunities_by_stage. Voice flows like 'log: had a call with Will from Connect today, talked about pricing, they want to see a demo Wednesday'. Henry parses the contact, creates the interaction, suggests a follow-up task. Same audit-stamp pattern as the existing Henry tools (created_by='henry')."],
];

let inserted = 0;
for (const [title, size, body] of cards) {
  const existing = await sql`SELECT id FROM ops.kanban_cards WHERE title = ${title} AND archived_at IS NULL`;
  if (existing.length) continue;
  const tags = ['epic:founder-crm', 'founder-os'];
  await sql`
    INSERT INTO ops.kanban_cards
      (board_id, column_key, title, body, tags, priority, size_points,
       suggested_agent, actor_type, actor_name, order_in_column)
    VALUES (${board.id}, 'backlog', ${title}, ${body}, ${tags}, 2, ${size},
            'collab', 'human', 'jonathan', 0)
  `;
  inserted++;
}

console.log(`board: founder-os | inserted ${inserted} cards`);
const t = await sql`SELECT count(*), sum(size_points) FROM ops.kanban_cards WHERE board_id = ${board.id} AND archived_at IS NULL`;
console.log(`founder-os board total: ${t[0].count} cards, ${t[0].sum} pts`);
await sql.end();
