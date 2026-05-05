/**
 * Competitor embodiment loader. When a session has target_competitor_slug
 * set AND the panel includes the Competitor Brain advisor, this loader
 * builds a deep brief from:
 *
 *   1. ops.competitors row → name, url, edge_notes, latest_findings
 *   2. ops.knowledge_docs tagged 'competitor:{slug}' (full body)
 *
 * The block is injected into the Competitor Brain's system prompt as
 * an "embodiment context" so the advisor can reason as that company's
 * strategist, not as a HeyHenry advisor. The user fills out the
 * underlying data over time; the loader picks it up automatically.
 */

import { createServiceClient } from '@/lib/supabase';

export type CompetitorOption = {
  slug: string;
  name: string;
  url: string | null;
  /** Bytes of edge_notes; surface in UI as "richness" hint. */
  notes_bytes: number;
};

/** Live list for the convene-form dropdown. */
export async function listCompetitorOptions(): Promise<CompetitorOption[]> {
  const svc = createServiceClient();
  const { data, error } = await svc
    .schema('ops')
    .from('competitors')
    .select('slug, name, url, edge_notes')
    .not('slug', 'is', null)
    .order('name', { ascending: true });
  if (error) throw new Error(`listCompetitorOptions: ${error.message}`);
  return (
    (data ?? []) as Array<{
      slug: string;
      name: string;
      url: string | null;
      edge_notes: string | null;
    }>
  ).map((c) => ({
    slug: c.slug,
    name: c.name,
    url: c.url,
    notes_bytes: (c.edge_notes ?? '').length,
  }));
}

export type CompetitorEmbodimentBrief = {
  slug: string;
  name: string;
  url: string | null;
  edge_notes: string | null;
  latest_findings: Record<string, unknown> | null;
  /** Knowledge docs tagged competitor:{slug}, sorted newest first. */
  research_docs: Array<{ slug: string; title: string; tags: string[]; body: string }>;
};

/**
 * Load the full embodiment brief for one competitor. Returns null if the
 * slug doesn't match a known competitor — the engine then falls back to
 * generic-mode for the Competitor Brain.
 */
export async function loadCompetitorBrief(slug: string): Promise<CompetitorEmbodimentBrief | null> {
  const svc = createServiceClient();
  const [competitorRes, knowledgeRes] = await Promise.all([
    svc
      .schema('ops')
      .from('competitors')
      .select('slug, name, url, edge_notes, latest_findings')
      .eq('slug', slug)
      .maybeSingle(),
    svc
      .schema('ops')
      .from('knowledge_docs')
      .select('slug, title, tags, body')
      .contains('tags', [`competitor:${slug}`])
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .limit(40),
  ]);
  if (competitorRes.error || !competitorRes.data) return null;

  const c = competitorRes.data as {
    slug: string;
    name: string;
    url: string | null;
    edge_notes: string | null;
    latest_findings: Record<string, unknown> | null;
  };
  const docs = (knowledgeRes.data ?? []) as Array<{
    slug: string;
    title: string;
    tags: string[] | null;
    body: string | null;
  }>;

  return {
    slug: c.slug,
    name: c.name,
    url: c.url,
    edge_notes: c.edge_notes,
    latest_findings: c.latest_findings,
    research_docs: docs.map((d) => ({
      slug: d.slug,
      title: d.title,
      tags: d.tags ?? [],
      body: d.body ?? '',
    })),
  };
}

/**
 * Render a brief into a Markdown block suitable for injection into the
 * Competitor Brain's system prompt. Sized to be substantial without
 * blowing the context window — research docs are NOT truncated here
 * (the user is curating them; let them fully load).
 */
export function renderCompetitorEmbodimentBlock(brief: CompetitorEmbodimentBrief): string {
  const lines: string[] = [
    `## You are now embodying: ${brief.name}`,
    '',
    `**Mode switch.** Despite the strategic posture above (which advises HeyHenry), your job in this session is to think AS ${brief.name}'s strategist. The chair will integrate your perspective into HeyHenry's decision; you don't have to soften your view for the panel. Be the company's actual interests, not a friendly external observer.`,
    '',
    `Reason from ${brief.name}'s:`,
    `- cap table and incentive structure`,
    `- product priorities and roadmap (what they have already shipped vs. what they are building)`,
    `- distribution and GTM model`,
    `- public posture vs. private bets (where stated strategy and observed moves diverge)`,
    `- view of HeyHenry as a threat vector — where would you attack? where would you ignore? where could you copy?`,
    '',
  ];

  if (brief.url) {
    lines.push(`**Public site:** ${brief.url}`, '');
  }

  if (brief.edge_notes && brief.edge_notes.trim().length > 0) {
    lines.push(`### Standing brief (ops.competitors.edge_notes)`, '', brief.edge_notes.trim(), '');
  }

  if (brief.latest_findings && typeof brief.latest_findings === 'object') {
    const keys = Object.keys(brief.latest_findings);
    if (keys.length > 0) {
      lines.push(
        `### Latest findings (structured)`,
        '',
        '```json',
        JSON.stringify(brief.latest_findings, null, 2),
        '```',
        '',
      );
    }
  }

  if (brief.research_docs.length > 0) {
    lines.push(
      `### Research dossier (${brief.research_docs.length} doc${brief.research_docs.length === 1 ? '' : 's'} tagged \`competitor:${brief.slug}\`)`,
      '',
    );
    for (const d of brief.research_docs) {
      lines.push(`#### ${d.title}`);
      if (d.tags.length > 0) {
        const otherTags = d.tags.filter(
          (t) => t !== `competitor:${brief.slug}` && t !== 'competitor',
        );
        if (otherTags.length > 0) lines.push(`*tags: ${otherTags.join(', ')}*`);
      }
      lines.push('', d.body || '*(empty)*', '');
    }
  } else {
    lines.push(
      `### Research dossier`,
      '',
      `*No knowledge_docs tagged \`competitor:${brief.slug}\` yet. Add some via the Knowledge UI to give yourself sharper teeth.*`,
      '',
    );
  }

  lines.push(
    `---`,
    '',
    `**When responding**, speak as ${brief.name}'s strategist. Use first-person plural where natural ("we ship", "our customers"). Don't be polite about HeyHenry. Don't pretend to know things you wouldn't — if the dossier doesn't cover it, say so explicitly.`,
  );

  return lines.join('\n');
}
