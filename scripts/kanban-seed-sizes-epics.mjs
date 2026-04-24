/**
 * Baseline stats for kanban sizing + epic tagging.
 *
 * Reads all non-archived ops.kanban_cards and prints:
 *   - total count, per-board breakdown
 *   - unsized count (size_points IS NULL)
 *   - un-tagged-with-epic count (no tag starting 'epic:')
 *   - launch-blocker count
 *
 * Does NOT auto-size or auto-tag. An agent (or manual pass)
 * will assign `size_points` and `epic:*` tags separately via
 * the `kanban_card_size` / `kanban_card_update` MCP tools.
 *
 * Safe to re-run. No mutations.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/kanban-seed-sizes-epics.mjs
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

const rows = await sql`
  SELECT c.id, c.title, c.tags, c.size_points, c.column_key, b.slug AS board_slug
  FROM ops.kanban_cards c
  JOIN ops.kanban_boards b ON b.id = c.board_id
  WHERE c.archived_at IS NULL
`;

const total = rows.length;
const byBoard = new Map();
let unsized = 0;
let untaggedEpic = 0;
let launchBlockers = 0;
for (const r of rows) {
  byBoard.set(r.board_slug, (byBoard.get(r.board_slug) ?? 0) + 1);
  if (r.size_points == null) unsized += 1;
  const tags = r.tags ?? [];
  if (!tags.some((t) => t.startsWith('epic:'))) untaggedEpic += 1;
  if (tags.includes('launch-blocker')) launchBlockers += 1;
}

console.log(`Total active cards: ${total}`);
console.log('');
console.log('By board:');
for (const [slug, n] of [...byBoard].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${slug}: ${n}`);
}
console.log('');
console.log(`Unsized (size_points IS NULL): ${unsized} / ${total}`);
console.log(`No epic:* tag:                 ${untaggedEpic} / ${total}`);
console.log(`Tagged launch-blocker:         ${launchBlockers} / ${total}`);

await sql.end();
