import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const board = await sql`SELECT id FROM ops.kanban_boards WHERE slug='dev'`;
const boardId = board[0].id;

const cards = [
  ['Add ToS + Privacy Policy acceptance at signup',
   "Required checkbox(es) on /signup before account creation. Store accepted_at + version in tenant_members or a new acceptances table. Block signup submit until checked. Versioned so re-prompt when policy changes.",
   2, 'trust-safety', true, 'ai'],
  ['Stripe Connect onboarding nudge after first signup',
   "New tenant lands without Stripe Connect set up — they hit a dead end when sending the first invoice. Add a persistent nudge on the dashboard + invoice send flow: 'Connect your payments to send invoices.' Deep-link to /settings/payments. Once connected, nudge disappears.",
   3, 'payments', true, 'ai'],
  ['Collect GST/HST number during onboarding',
   "Canadian tax compliance requires GST/HST number on invoices. Add field to onboarding wizard with format validation (9-digit RT0001 pattern). Store on tenant. Surface as warning on invoices when missing.",
   2, 'trust-safety', true, 'ai'],
  ['Guided onboarding wizard with progress meter',
   "Post-signup multi-step wizard (single page if data is small enough). Collects: first+last name, vertical, ToS acceptance, GST/HST number, business address. Show progress meter ONLY if it spans >1 step. Save partial state — user can leave + come back. Hard rule: do not demand everything upfront. Stripe Connect, full crew setup, etc. happen JIT later.",
   8, 'sacred-path', true, 'collab'],
  ['First-use quick-start tips & contextual hints',
   "New users land in the dashboard not knowing where to start. Add: (1) one-time welcome modal with 3-4 key actions, (2) inline tips that appear in empty states (e.g. on /projects: 'The Add to Project button is your friend — drop in photos, PDFs, emails, anything'), (3) dismissible tip strip per feature area. NOT a guided product tour — keep it lightweight and useful.",
   3, 'sacred-path', true, 'collab'],
  ['Progressive feature unlock — JIT setup prompts',
   "Smart onboarding: when a user enters an area they have not set up yet, prompt for required info inline. Examples: opening invoices without Stripe Connect → setup card; tagging a job as taxable without GST number → modal; assigning a worker without phone verification done → block + nudge. Each gate has clear 'set up' vs 'skip for now' paths. Avoids upfront-onboarding-fatigue while ensuring the user has what they need WHEN they need it.",
   8, 'sacred-path', false, 'collab'],
];

let inserted = 0;
for (const [title, body, size, epic, blocker, agent] of cards) {
  const existing = await sql`SELECT id FROM ops.kanban_cards WHERE title = ${title} AND archived_at IS NULL`;
  if (existing.length) continue;
  const tags = [`epic:${epic}`, ...(blocker ? ['launch-blocker'] : [])];
  await sql`
    INSERT INTO ops.kanban_cards
      (board_id, column_key, title, body, tags, priority, size_points,
       suggested_agent, actor_type, actor_name, order_in_column)
    VALUES (${boardId}, 'backlog', ${title}, ${body}, ${tags}, 2, ${size},
            ${agent}, 'human', 'jonathan', 0)
  `;
  inserted++;
}

const s = await sql`
  SELECT
    sum(size_points) FILTER (WHERE 'launch-blocker' = ANY(tags)) AS pts,
    sum(size_points) FILTER (WHERE 'launch-blocker' = ANY(tags) AND column_key='done') AS done_pts,
    count(*) FILTER (WHERE 'launch-blocker' = ANY(tags)) AS cards,
    count(*) FILTER (WHERE 'launch-blocker' = ANY(tags) AND column_key='done') AS done_cards
  FROM ops.kanban_cards WHERE archived_at IS NULL
`;
console.log('inserted:', inserted);
console.log(`V1 readiness: ${s[0].done_cards}/${s[0].cards} cards, ${s[0].done_pts}/${s[0].pts} pts (${(s[0].done_pts / s[0].pts * 100).toFixed(1)}%)`);
await sql.end();
