import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

// Column map: HenryOS → ops
const COL = { Backlog: 'backlog', 'Up Next': 'todo', 'In Progress': 'doing', Done: 'done' };
const PRI = { '🔴': 1, '🟠': 2, '🟡': 3, '⚪': 4 }; // missing emoji = 3
const OWN = { Me: { assignee: 'jonathan', suggested_agent: null },
              AI: { assignee: null, suggested_agent: 'ai' },
              Collab: { assignee: null, suggested_agent: 'collab' } };

const cards = [
  // title, henryos_id, column, priority_emoji, owner
  // --- Backlog, HeyHenry/Smartfusion product + infra ---
  ['Smartfusion: Build marketing website / sales page', '94d5847c-43b8-49b1-a01c-d20c4b76505d', 'Backlog', '🟠', 'Collab', 'marketing'],
  ['HeyHenry: Trade selector + vertical landing pages', 'c030f062-e259-48d0-8fc6-bc30323064dc', 'Backlog', '🟡', 'Collab', 'marketing'],
  ['HeyHenry: QuickBooks Online (QBO) integration — V1 requirement', '31dc5187-b1f2-45f1-8a39-f3272502da67', 'Backlog', '🔴', 'AI', 'dev'],
  ['HeyHenry: Wave accounting integration — native', '01caa9c4-24cb-4bb6-b12e-ab246c68d81b', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: Proactive lifecycle agents — unbilled job detector + nudge system', '46b45afb-4f70-49ea-9717-cb1d0a513c27', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: Trigger.dev agent infrastructure setup', 'f96ed6ea-ee4f-4fb3-a307-9b004562ac11', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: SMS support channel — Henry via Twilio', '865cfdec-be32-4c0d-98be-711956d8a51b', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: Gusto payroll integration — evaluate', '24a72845-e7ba-46c6-9786-9b8d0a442b1c', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: Photo system — research + redesign for large jobs', 'f0dd9ef5-766f-4736-9e7d-54e6c25b5ab9', 'Backlog', '🟠', 'Collab', 'dev'],
  ['HeyHenry: Interac e-Transfer — invoice payment via Helcim', 'cc942479-c3d2-472a-a2ef-04e6409bd4d6', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: GoCardless PAD — pre-authorized debit for recurring jobs', '89fe4c84-e88a-4f8f-ab56-c169909881f7', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: Financeit integration — Canadian contractor financing', 'b4c90056-2c50-4b59-9107-afc681c7df34', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: Helcim — Canadian card processing partner', 'a0b80a76-9b2c-4e7d-aee8-0606b6840906', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: PayPal — invoice payment checkbox', 'e4ade14a-bc24-4982-8164-5bb39abeb80b', 'Backlog', '⚪', 'AI', 'dev'],
  ['HeyHenry: Record payment — cash/cheque (table stakes)', '91d244f9-3508-475a-a8bb-e9bcb7eab775', 'Backlog', '🔴', 'AI', 'dev'],
  ['HeyHenry: Gantt / phase timeline — renovation vertical (V2)', '7cae9144-4094-4ce7-a02d-d98423624efa', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: Vertical profile system — adaptive workspace per trade', '0c1b1b74-6ecd-46ce-bce8-856da89bf64c', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: Module marketplace — discover and enable features across verticals', '7515f517-1de8-4576-a1bc-1f7d98cc9080', 'Backlog', '🟡', 'AI', 'dev'],
  ['Henry briefing button — tap to get daily business summary', 'b320950d-16a8-4ac1-a8f5-82da3b5d7d10', 'Backlog', '🟠', 'AI', 'dev'],
  ['Quote accepted → auto-prompt job creation', 'fd50575b-2a6d-4911-9827-5197aca3c43f', 'Backlog', '🟠', 'AI', 'dev'],
  ['Job complete → auto-prompt invoice creation', '73568406-5a3f-4a51-a97d-7faabbb708ac', 'Backlog', '🟠', 'AI', 'dev'],
  ['PDF generation for quotes and invoices', '323615ff-acb9-48d7-b789-cc8be2bd6001', 'Backlog', '🔴', 'AI', 'dev'],
  ['AR branch step evaluation (conditional sequences)', '93703025-00e9-46a6-a4c5-524c650ee578', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: Automated workflow testing stack', '0bdceca4-6c6a-40a7-a6e0-20317596bc14', 'Backlog', '🟡', 'AI', 'dev'],
  ['Email ingestion for sub-trade quotes', 'caeec410-c7cd-4859-8b96-cecea0743bd4', 'Backlog', '🟠', 'Me', 'dev'],
  ['Local supplier pricing integration', '5db564e4-07b5-4218-bd54-6db9618d1b21', 'Backlog', '🟡', 'Me', 'dev'],
  ['Job Cost Control module — V1 core', 'c24d0da6-9dd1-489c-9d7f-2d85a289dfea', 'Backlog', '🔴', 'Me', 'dev'],
  ['Migration wizard — smart import with dirty data rescue', '69cfb888-bb49-4f02-a153-27424e6d378c', 'Backlog', '🟠', 'Me', 'dev'],
  ['Job Cost Control — V2 materials lifecycle + variance alerts', '17364099-0c75-4a67-ae22-0f358125d075', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: henry@heyhenry.io — unified Henry email address', 'dad8e6bc-3254-4133-87cb-50003edcba1b', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: Gmail label-based read integration (research)', '4475ef64-92d3-4adb-91d8-27ddf5857070', 'Backlog', '⚪', 'Me', 'dev'],
  ['HeyHenry: Customer-facing quote status page', '6dfcbc80-eb3b-42c5-a46d-8a5418892038', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: Pre-contract scope Q&A tracker', 'be50620b-44f2-4fed-ab2c-a3c1833c3387', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: Quote commitment tracker ("promised by" date)', '51722748-98ac-4a0c-abd4-f44a3c8e1c17', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: "Awaiting sub-quote" blocker status on quotes', '936738d3-ab0e-42f7-bc91-4d82f8433ccc', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: Quote revision history (v1, v2, v3 with change notes)', 'f0397a24-b64d-4c33-9138-82a27fe6ba05', 'Backlog', '⚪', 'AI', 'dev'],
  ['Expose HenryOS worklog via HTTP API + public /changelog on heyhenry.io', '30d19e0a-0cad-4f5d-8dd2-e9acc0a3b97c', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: Customer Attribution Engine (embedded forms + UTM/referrer reporting)', '8a573df0-b432-4517-a517-a3549c5ac34d', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: Referral Engine + Thank You System', '6c05ed10-852c-42cf-9465-ae83697f9c78', 'Backlog', '🟡', 'Me', 'dev'],
  ['Hot-swappable AI models + live split testing + cost dashboard', '599672a5-6d32-4d42-888a-5b1dda09a10b', 'Backlog', '⚪', 'Me', 'dev'],
  ['US data residency architecture + multi-region platform design', '07ad72d2-49f3-4600-b61c-f61f2cfd1a3d', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: On-device vision quoting via react-native-executorch (YOLO segmentation)', 'ebc7384e-232d-49f8-9edc-e7e3e5682238', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: Pilot AI Accountant integration / affiliate partnership', 'f0672b61-fae4-4ed9-9423-de2636c529ba', 'Backlog', '⚪', 'Me', 'dev'],
  ['HeyHenry Launch: AI newsletter features (The Rundown, TLDR, etc.)', 'c7c5063f-986f-4c68-91c6-faff1cd10ee1', 'Backlog', '🟡', 'Me', 'marketing'],
  ['HeyHenry: GPT-4o Realtime as voice fallback provider', '3e93edb5-8224-4247-bbdc-2625273d3c3b', 'Backlog', '⚪', 'Me', 'dev'],
  ['HeyHenry: Easter Eggs & Henry Personality System', '42ae07ea-a192-43dd-82dc-e0e2783f8eb6', 'Backlog', '⚪', 'Collab', 'dev'],
  ['HeyHenry: AI provider abstraction + OpenRouter fallback for rate limits', '489c8958-6159-4106-86fc-1fd1470fb87b', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: Henry Character Design — Illustrator Brief & Asset Production', '7af9f6f0-3cdc-406a-9e28-5a9ababc76f8', 'Backlog', '⚪', 'Collab', 'marketing'],
  ['HeyHenry signup: add vertical picker', '0647aa5e-700f-40f6-93e9-6891aff530e0', 'Backlog', '🟡', 'Me', 'dev'],
  ['Smartfusion: Bill line item extraction + nested view', '5f0179f7-8632-4d42-9bda-a905fa4f5a43', 'Backlog', '🟡', 'Me', 'dev'],
  ['Smartfusion: Show bucket/line detail on accepted change orders', '61efd457-bdfe-4fa3-8db7-6cb7084ba9e3', 'Backlog', '🟡', 'Me', 'dev'],
  ['Smartfusion: Merge accepted CO lines into estimate (project_cost_lines)', '56834250-8ddd-48d9-ac78-1b648894b2aa', 'Backlog', '🟡', 'Me', 'dev'],
  ['Smartfusion: Estimate versioning — snapshot on send', '5a2b9398-4dd5-4851-b265-cddce1cdc46b', 'Backlog', '🟡', 'Me', 'dev'],
  ['Smartfusion: "Add to Project" as universal intelligent inbox', '05fe6570-de38-4631-bf23-8ac45c8b2f95', 'Backlog', '🟠', 'Me', 'dev'],
  ['Support negative expense amounts (credits/returns)', 'f1c00750-16a3-4425-a9ea-4eb6bc0f06bd', 'Backlog', '🟡', 'Me', 'dev'],
  ['Edit existing expenses (change bucket, amount, description)', '69afb639-2875-43ee-8016-e878a9cad9f6', 'Backlog', '🟡', 'Me', 'dev'],
  ['iPhone shortcut deep link into Add to Project', 'c2877824-643d-4707-a160-a823a812c5e4', 'Backlog', '🟡', 'Me', 'dev'],
  ['Restructure Pipeline + Projects tabs, integrate metrics into dashboard', '15062a02-c1ea-4577-a877-76f1b78049d8', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: Canada/US architecture + multi-region data residency', 'bc14a277-dc1d-4182-8d99-161f7e9be612', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: Sub quotes — intake + multi-bucket allocation', '1a2daba9-d6ef-4f46-8d1c-efe4defb14d8', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: henry@heyhenry.io inbound email infrastructure', 'a88395c6-a2e3-4cf6-97ca-9e32892553fb', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: iOS Share Extension — personal SMS → Henry lead intake', '716dbb45-6afd-4ddf-a847-7b9f5b874904', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: Drop-zone-first new project creation (skip selector screen)', '33a0b719-d7b0-47c5-98bc-9e1ed198e271', 'Backlog', '🟠', 'Collab', 'dev'],
  ['HeyHenry: New vs. existing project routing in intake', '8a668391-3e91-4541-af3d-992219a23b75', 'Backlog', '🟠', 'AI', 'dev'],
  ['HeyHenry: Project activity timeline (daily log equivalent)', '72989158-8e71-4227-bc51-60752e5805dc', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: Plain-text and contact-paste project creation', 'e70d336b-a021-4604-b34e-17d164f74b2e', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: require first + last name at signup / onboarding', 'd45a04f6-e9d7-4516-b8f8-1328ced35161', 'Backlog', '🟡', 'Me', 'dev'],
  ['HeyHenry: Invoicing overhaul — research + redesign', '5ad5d75c-0e13-48c8-8e61-f664d83648dd', 'Backlog', '🟠', 'Collab', 'dev'],
  ['HeyHenry: unify project lifecycle (estimate → project)', '8190d7f2-0105-4d13-aacf-8fc890d27325', 'Backlog', '🟠', 'Me', 'dev'],
  ['HeyHenry: Collapsible customer feedback section on estimate screen', '047f1953-64ad-442d-a663-6d044eb6e10a', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: Henry proactive quarterly GST report', '412b4151-c205-4b32-8c9e-66c5316598f0', 'Backlog', '🟡', 'AI', 'dev'],
  ['HeyHenry: Add active projects to mobile dashboard (above pipeline)', '29855c98-3cf8-4fd9-8d23-52c47a96c93c', 'Backlog', '🟠', 'AI', 'dev'],
  // --- Done ---
  ['Owner calendar view (all projects + workers)', 'ed4b308b-eccb-4b94-8fbc-9b55223e2a94', 'Done', '🟡', 'Me', 'dev'],
  ['Email + SMS verification during onboarding', '25cf1d69-3174-4d27-bf45-6a7967971060', 'Done', '🟡', 'Me', 'dev'],
  ['Estimate engagement: first-view card + email/SMS notification', '8f7f21cd-9767-4cf1-9c58-a547b5a7ed2b', 'Done', '🟡', 'Me', 'dev'],
];

const boards = await sql`SELECT id, slug FROM ops.kanban_boards`;
const boardId = Object.fromEntries(boards.map(b => [b.slug, b.id]));

let inserted = 0;
for (const [title, henryosId, col, emoji, owner, board] of cards) {
  const { assignee, suggested_agent } = OWN[owner];
  const column_key = COL[col];
  const priority = PRI[emoji] ?? 3;
  const body = `Migrated from HenryOS kanban 2026-04-23.\n\nHenryOS card: \`${henryosId}\`\n\nFull description and history remain in HenryOS. New activity should happen here.`;
  const tags = ['henryos-migration', '2026-04-23', owner.toLowerCase()];
  const done_at = column_key === 'done' ? new Date() : null;
  const [row] = await sql`
    INSERT INTO ops.kanban_cards
      (board_id, column_key, title, body, tags, priority, assignee, suggested_agent,
       actor_type, actor_name, done_at, order_in_column)
    VALUES (${boardId[board]}, ${column_key}, ${title}, ${body}, ${tags}, ${priority},
            ${assignee}, ${suggested_agent}, 'system', 'henryos-migration',
            ${done_at}, ${inserted})
    RETURNING id
  `;
  inserted++;
}

const counts = await sql`
  SELECT b.slug, c.column_key, count(*)::int AS n
  FROM ops.kanban_cards c JOIN ops.kanban_boards b ON b.id = c.board_id
  GROUP BY b.slug, c.column_key
  ORDER BY b.slug, c.column_key
`;
console.log(`inserted ${inserted} cards`);
for (const r of counts) console.log(`  ${r.slug} / ${r.column_key}: ${r.n}`);

await sql.end();
