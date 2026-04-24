#!/usr/bin/env node
/**
 * One-time pull of HenryOS ideas (tag=heyhenry) into ops.ideas.
 *
 * Idempotent: skips any HenryOS idea whose id already appears in an existing
 * ops.ideas row's tags (via tag `henryos-id:<uuid>`).
 *
 * Flags:
 *   --dry-run   Fetch from HenryOS, print counts, do not write.
 *
 * Env:
 *   DATABASE_URL   postgres URL (required unless --dry-run)
 *   HENRYOS_URL    default http://localhost:7100
 */
import postgres from 'postgres';

const DRY_RUN = process.argv.includes('--dry-run');
const HENRYOS_URL = process.env.HENRYOS_URL ?? 'http://localhost:7100';
const TODAY = new Date().toISOString().slice(0, 10);
const MIGRATION_TAG = `henryos-migration:${TODAY}`;

async function fetchHenryosIdeas() {
  const all = [];
  let page = 1;
  for (;;) {
    const url = `${HENRYOS_URL}/api/ideas?tag=heyhenry&page=${page}&limit=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HenryOS ${res.status} ${res.statusText} on ${url}`);
    const body = await res.json();
    const batch = body.ideas ?? body.data ?? body ?? [];
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
    if (page > 50) throw new Error('Refusing to paginate past 50 pages');
  }
  return all;
}

function henryosIdTag(id) {
  return `henryos-id:${id}`;
}

async function main() {
  const ideas = await fetchHenryosIdeas();
  console.log(`fetched: ${ideas.length}`);

  if (DRY_RUN) {
    console.log('dry-run — no writes');
    console.log(`would tag migration batch as: ${MIGRATION_TAG}`);
    if (ideas[0]) {
      console.log('sample idea keys:', Object.keys(ideas[0]).join(', '));
    }
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL required (or use --dry-run)');
  }
  const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

  // Load existing henryos ids from ops.ideas tags for idempotency.
  const existing = await sql`
    SELECT unnest(tags) AS tag FROM ops.ideas WHERE tags && ARRAY['heyhenry']::text[]
  `;
  const seen = new Set(
    existing
      .map((r) => r.tag)
      .filter((t) => typeof t === 'string' && t.startsWith('henryos-id:'))
      .map((t) => t.slice('henryos-id:'.length)),
  );

  let inserted = 0;
  let skipped = 0;
  for (const i of ideas) {
    const hid = i.id ?? i.idea_id;
    if (!hid) {
      skipped++;
      continue;
    }
    if (seen.has(hid)) {
      skipped++;
      continue;
    }
    const title = (i.title ?? i.name ?? '').toString().slice(0, 500) || '(untitled)';
    const body = (i.description ?? i.body ?? i.notes ?? null) || null;
    const createdAt = i.createdAt ?? i.created_at ?? new Date().toISOString();
    const origTags = Array.isArray(i.tags) ? i.tags.filter((t) => typeof t === 'string') : [];
    const tags = Array.from(new Set([...origTags, MIGRATION_TAG, henryosIdTag(hid)]));

    await sql`
      INSERT INTO ops.ideas (title, body, tags, actor_type, actor_name, created_at)
      VALUES (${title}, ${body}, ${tags}, 'agent', 'henryos-migration', ${createdAt})
    `;
    inserted++;
  }

  console.log(`inserted: ${inserted}`);
  console.log(`skipped:  ${skipped}`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
