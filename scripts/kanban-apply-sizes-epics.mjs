/**
 * One-time sizing + epic tagging pass for the HenryOS-migrated cards.
 *
 * Matches cards by title substring and sets size_points (Fibonacci),
 * adds `epic:<slug>` tag, and flags `launch-blocker` where applicable.
 *
 * Idempotent: re-running overrides size, preserves pre-existing tags,
 * re-adds epic/blocker tags without duplication.
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

// [title_substring, size_points, epic, launch_blocker?]
const PLAN = [
  // Launch blockers
  ['QuickBooks Online (QBO) integration', 21, 'payments', true],
  ['Record payment — cash/cheque', 3, 'payments', true],
  ['Job Cost Control module — V1 core', 21, 'job-cost', true],
  ['PDF generation for quotes and invoices', 8, 'sacred-path', true],
  ['Quote accepted → auto-prompt job', 2, 'sacred-path', true],
  ['Job complete → auto-prompt invoice', 3, 'sacred-path', true],
  ['require first + last name at signup', 2, 'trust-safety', true],
  // Sacred path polish
  ['Collapsible customer feedback section', 2, 'sacred-path', false],
  ['Customer-facing quote status page', 5, 'sacred-path', false],
  ['Quote commitment tracker', 3, 'sacred-path', false],
  ['"Awaiting sub-quote" blocker', 3, 'sacred-path', false],
  ['Pre-contract scope Q&A tracker', 5, 'sacred-path', false],
  ['Quote revision history', 8, 'sacred-path', false],
  ['Henry briefing button', 3, 'sacred-path', false],
  ['Add active projects to mobile dashboard', 3, 'sacred-path', false],
  ['Restructure Pipeline + Projects tabs', 3, 'sacred-path', false],
  // Payments
  ['Wave accounting integration', 8, 'payments', false],
  ['Interac e-Transfer', 8, 'payments', false],
  ['GoCardless PAD', 8, 'payments', false],
  ['Financeit integration', 8, 'payments', false],
  ['Helcim — Canadian card processing', 8, 'payments', false],
  ['PayPal — invoice payment', 3, 'payments', false],
  ['Gusto payroll integration', 8, 'payments', false],
  ['Pilot AI Accountant integration', 5, 'payments', false],
  // Invoicing
  ['Invoicing overhaul', 13, 'invoicing', false],
  ['Henry proactive quarterly GST report', 8, 'invoicing', false],
  // Job cost / reno
  ['Job Cost Control — V2', 13, 'job-cost', false],
  ['Local supplier pricing', 13, 'job-cost', false],
  ['Sub quotes — intake + multi-bucket', 8, 'job-cost', false],
  ['Email ingestion for sub-trade quotes', 13, 'job-cost', false],
  ['Bill line item extraction', 5, 'job-cost', false],
  ['Show bucket/line detail on accepted change orders', 3, 'job-cost', false],
  ['Merge accepted CO lines into estimate', 5, 'job-cost', false],
  ['Estimate versioning', 5, 'job-cost', false],
  ['Support negative expense amounts', 2, 'job-cost', false],
  ['Edit existing expenses', 3, 'job-cost', false],
  ['Gantt / phase timeline', 13, 'reno', false],
  ['Project activity timeline', 8, 'reno', false],
  // Intake
  ['"Add to Project" as universal intelligent inbox', 13, 'intake', false],
  ['Drop-zone-first new project', 5, 'intake', false],
  ['New vs. existing project routing', 5, 'intake', false],
  ['Plain-text and contact-paste project', 5, 'intake', false],
  ['iOS Share Extension', 13, 'intake', false],
  ['iPhone shortcut deep link', 2, 'intake', false],
  ['unify project lifecycle', 13, 'intake', false],
  // Agents
  ['Proactive lifecycle agents', 13, 'agents', false],
  ['Trigger.dev agent infrastructure', 5, 'agents', false],
  ['SMS support channel — Henry via Twilio', 8, 'agents', false],
  ['AI provider abstraction + OpenRouter', 13, 'agents', false],
  ['GPT-4o Realtime as voice fallback', 5, 'agents', false],
  ['Gmail label-based read integration', 5, 'agents', false],
  ['henry@heyhenry.io — unified Henry email', 2, 'agents', false],
  ['henry@heyhenry.io inbound email infrastructure', 13, 'agents', false],
  ['On-device vision quoting', 21, 'agents', false],
  ['AR branch step evaluation', 3, 'agents', false],
  // Vertical adaptation
  ['Vertical profile system — adaptive workspace', 13, 'vertical-adapt', false],
  ['Module marketplace', 13, 'vertical-adapt', false],
  ['vertical picker', 3, 'vertical-adapt', false],
  // Growth
  ['Migration wizard — smart import', 13, 'growth', false],
  ['Customer Attribution Engine', 8, 'growth', false],
  ['Referral Engine', 8, 'growth', false],
  ['Smartfusion: Build marketing website', 13, 'growth', false],
  ['Trade selector + vertical landing pages', 5, 'growth', false],
  ['AI newsletter features', 3, 'growth', false],
  ['Henry Character Design', 8, 'growth', false],
  // Platform
  ['US data residency architecture', 21, 'platform', false],
  ['Canada/US architecture + multi-region', 21, 'platform', false],
  ['Automated workflow testing', 13, 'platform', false],
  ['Hot-swappable AI models', 13, 'platform', false],
  ['Expose HenryOS worklog via HTTP API', 5, 'platform', false],
  ['Roadmap visualization — epic progress', 8, 'platform', false],
  // Photos
  ['Photo system — research + redesign', 13, 'photos', false],
  // Delight
  ['Easter Eggs & Henry Personality', 8, 'delight', false],
  // Already done
  ['Owner calendar view', 5, 'reno', false],
  ['Email + SMS verification during onboarding', 3, 'trust-safety', true],
  ['Estimate engagement: first-view card', 5, 'sacred-path', true],
];

let updated = 0;
const notFound = [];
for (const [needle, size, epic, isBlocker] of PLAN) {
  const extraTags = [`epic:${epic}`, ...(isBlocker ? ['launch-blocker'] : [])];
  const r = await sql`
    UPDATE ops.kanban_cards
    SET size_points = ${size},
        tags = (
          SELECT array_agg(DISTINCT t)
          FROM unnest(tags || ${extraTags}::text[]) t
        ),
        updated_at = now()
    WHERE title ILIKE ${'%' + needle + '%'}
      AND archived_at IS NULL
    RETURNING id
  `;
  if (r.length === 0) notFound.push(needle);
  else updated += r.length;
}

const unsized = await sql`SELECT title FROM ops.kanban_cards WHERE size_points IS NULL AND archived_at IS NULL`;
const summary = await sql`
  SELECT
    count(*) FILTER (WHERE size_points IS NOT NULL) AS sized,
    count(*) FILTER (WHERE 'launch-blocker' = ANY(tags)) AS blockers,
    sum(size_points) FILTER (WHERE size_points IS NOT NULL) AS total_pts,
    sum(size_points) FILTER (WHERE 'launch-blocker' = ANY(tags)) AS blocker_pts,
    sum(size_points) FILTER (WHERE 'launch-blocker' = ANY(tags) AND column_key='done') AS blocker_done_pts
  FROM ops.kanban_cards
  WHERE archived_at IS NULL
`;

console.log('updated rows:', updated, '| notFound patterns:', notFound.length);
if (notFound.length) for (const n of notFound) console.log('  MISSED:', n);
console.log('still unsized:', unsized.length);
if (unsized.length) for (const u of unsized.slice(0, 20)) console.log('  UNSIZED:', u.title);
console.log('summary:', summary[0]);

await sql.end();
