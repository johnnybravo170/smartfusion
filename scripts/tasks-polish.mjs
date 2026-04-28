import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const board = await sql`SELECT id FROM ops.kanban_boards WHERE slug='dev'`;
const boardId = board[0].id;

const cards = [
  ['Twilio SMS + Expo push wire-up for notifications table', 5,
   "Phase 3+4 wrote a notifications table + writeNotification stub at every push-worthy event (task assigned, done, blocked, help requested, verified, rejected, henry_suggestion). Wire actual delivery: Twilio SMS for owner→worker + worker→owner real-time, Expo push when the native app exists. Owner notifications batch into hourly digest unless severity=urgent. Worker notifications are immediate. Single dispatcher in src/server/notifications/dispatch.ts that reads unsent rows from notifications table and sends. Cron every minute or push-on-write."],

  ['Nightly briefing delivery channel — daily email or SMS to owner', 3,
   "buildMorningBriefing(tenantId) already returns the structured data and get_morning_briefing Henry tool calls it on demand. Wire a delivery channel so it lands on Jonathan's phone every morning at 6am Pacific without him asking. Options: (a) SMS via Twilio with link to dashboard, (b) HTML email via Resend (matches the Pulse template style), (c) both. Most likely: email by default with SMS toggle on tenant_prefs. Cron entry in vercel.json or extend /api/cron/henry-nightly."],

  ['Photo-task linkage — tasks can require + accept photos', 5,
   "Tasks already have required_photos boolean. Wire the actual photo association: photos table gets nullable task_id; worker 'Add photo' button on the worker mobile view uploads scoped to the current task; project task list shows a photo strip on tasks with attached photos; verify queue surfaces required-photo tasks that don't have a photo yet (so owner can reject). Closes the loop on the 'tile install' style task where the photo IS the proof of work."],

  ['Pulse auto-suggestion trigger — Henry nudges owner to send Pulse', 2,
   "When ≥3 tasks verified since last sent pulse OR phase transition OR 7+ days since last sent pulse, Henry writes a henry_suggestion notification: 'Send a Pulse update?'. Owner sees in dashboard Needs You. Trigger location: src/server/ai/triggers.ts (already exists from Phase 4) — add maybeSuggestPulse(jobId) helper, call from verifyTaskAction and from a daily check inside the existing nightly cron."],

  ['Inline worker picker on task row — assign without leaving the list', 2,
   "Owner can currently assign tasks via Henry's assign_task tool. Add a UI shortcut: clickable assignee field on each project task row → small dropdown listing tenant workers. Calls existing assignTaskAction. No new server logic needed, just the picker component. Match the pattern from existing assignment dropdowns in the app."],

  ['Reject-with-note proper modal (replace window.prompt)', 1,
   "rejectVerificationAction works today via browser window.prompt() in verify-task-buttons.tsx. Replace with a proper modal matching the existing confirm-dialog pattern in PATTERNS.md. Same UX: textarea for note, Cancel + Reject buttons. Required field with min-length validation. Single component, used only here."],
];

let inserted = 0;
for (const [title, size, body] of cards) {
  const existing = await sql`SELECT id FROM ops.kanban_cards WHERE title = ${title} AND archived_at IS NULL`;
  if (existing.length) continue;
  const tags = ['epic:tasks-polish', 'tasks', 'follow-up'];
  await sql`
    INSERT INTO ops.kanban_cards
      (board_id, column_key, title, body, tags, priority, size_points,
       suggested_agent, actor_type, actor_name, order_in_column)
    VALUES (${boardId}, 'backlog', ${title}, ${body}, ${tags}, 3, ${size},
            'ai', 'human', 'jonathan', 0)
  `;
  inserted++;
}

console.log(`inserted ${inserted} polish cards`);
const total = await sql`SELECT count(*), sum(size_points) FROM ops.kanban_cards WHERE 'epic:tasks-polish' = ANY(tags) AND archived_at IS NULL`;
console.log(`tasks-polish epic: ${total[0].count} cards, ${total[0].sum} pts`);
await sql.end();
