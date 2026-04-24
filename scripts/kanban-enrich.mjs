import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const cards = await sql`
  SELECT id, title, body FROM ops.kanban_cards
  WHERE 'henryos-migration' = ANY(tags)
`;

let enriched = 0, missing = 0, errors = 0;
for (const c of cards) {
  const m = c.body.match(/HenryOS card: `([0-9a-f-]+)`/);
  if (!m) { missing++; continue; }
  const henryosId = m[1];
  try {
    const res = await fetch(`http://localhost:7100/api/kanban/cards/${henryosId}`);
    if (!res.ok) { errors++; continue; }
    const { card } = await res.json();
    const desc = (card.description ?? '').trim();
    if (!desc) { missing++; continue; }
    const newBody = `${desc}\n\n---\n*Migrated from HenryOS kanban 2026-04-23. Original ID: \`${henryosId}\`*`;
    await sql`UPDATE ops.kanban_cards SET body = ${newBody}, updated_at = now() WHERE id = ${c.id}`;
    enriched++;
  } catch (e) {
    errors++;
  }
}

console.log(`enriched: ${enriched}, missing body: ${missing}, errors: ${errors}, total: ${cards.length}`);
await sql.end();
