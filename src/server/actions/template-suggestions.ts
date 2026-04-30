'use server';

/**
 * Henry-suggested templates from quote history.
 *
 * Clusters the operator's recent projects by structural similarity
 * (shared bucket names + overlapping line labels). When a cluster
 * of 3+ similar projects is found, surface a "save this pattern as a
 * template?" suggestion — operator-confirmed, never silent.
 *
 * Rule-based clustering for v1 (no LLM in the critical path). Cheap
 * + deterministic; we can layer prompt-based clustering on top later.
 *
 * See decision 6790ef2b — Henry as suggester, not commander. Operators
 * always click through to confirm.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { StarterTemplate } from '@/data/starter-templates/types';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type TemplateSuggestionCluster = {
  /** Stable hash of the bucket-name set so repeated runs return same cluster id. */
  cluster_id: string;
  /** Operator-facing label, e.g. "Bathroom-style projects". */
  label: string;
  /** Human-readable cluster summary. */
  description: string;
  /** Project count in the cluster (always ≥3). */
  project_count: number;
  /** The N most recent project IDs in the cluster. */
  sample_project_ids: string[];
  /** Pre-built scaffold ready for one-click save. */
  scaffold: StarterTemplate;
};

const MIN_CLUSTER_SIZE = 3;
const SAMPLE_LIMIT = 20;

/**
 * Find clusters worth surfacing to the operator. Returns up to 3
 * suggestions ordered by cluster size (most repeated patterns first).
 */
export async function getTemplateSuggestionsAction(): Promise<TemplateSuggestionCluster[]> {
  const tenant = await getCurrentTenant();
  if (!tenant) return [];

  const admin = createAdminClient();

  // Pull the most recent N projects with their bucket structure.
  const { data: projects } = await admin
    .from('projects')
    .select('id, name, created_at')
    .eq('tenant_id', tenant.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(SAMPLE_LIMIT);

  type ProjectRow = { id: string; name: string; created_at: string };
  const projectRows = (projects ?? []) as ProjectRow[];
  if (projectRows.length < MIN_CLUSTER_SIZE) return [];

  const projectIds = projectRows.map((p) => p.id);

  const [bucketsRes, linesRes] = await Promise.all([
    admin
      .from('project_budget_categories')
      .select('id, project_id, name, section, display_order')
      .in('project_id', projectIds),
    admin
      .from('project_cost_lines')
      .select('project_id, budget_category_id, label, category, qty, unit, sort_order')
      .in('project_id', projectIds),
  ]);

  type BucketRow = {
    id: string;
    project_id: string;
    name: string;
    section: string;
    display_order: number;
  };
  type LineRow = {
    project_id: string;
    budget_category_id: string | null;
    label: string;
    category: string;
    qty: number;
    unit: string;
    sort_order: number;
  };

  const bucketsByProject = new Map<string, BucketRow[]>();
  for (const b of (bucketsRes.data ?? []) as BucketRow[]) {
    const arr = bucketsByProject.get(b.project_id) ?? [];
    arr.push(b);
    bucketsByProject.set(b.project_id, arr);
  }
  const linesByProject = new Map<string, LineRow[]>();
  for (const l of (linesRes.data ?? []) as LineRow[]) {
    const arr = linesByProject.get(l.project_id) ?? [];
    arr.push(l);
    linesByProject.set(l.project_id, arr);
  }

  // Cluster signature: sorted bucket-name set. Two projects with the
  // same set of bucket names are considered structurally similar
  // enough to be in the same cluster. v1 ignores section + line
  // labels for clustering; we'll add line-label overlap on top once
  // bucket-set clustering shows real signal.
  type ClusterSig = string;
  const clustersBySig = new Map<
    ClusterSig,
    { projects: string[]; bucketCounts: Map<string, number> }
  >();
  for (const p of projectRows) {
    const buckets = bucketsByProject.get(p.id) ?? [];
    if (buckets.length === 0) continue;
    const sig = Array.from(new Set(buckets.map((b) => b.name.trim().toLowerCase())))
      .sort()
      .join('|');
    if (!sig) continue;
    const cluster: { projects: string[]; bucketCounts: Map<string, number> } = clustersBySig.get(
      sig,
    ) ?? {
      projects: [],
      bucketCounts: new Map<string, number>(),
    };
    cluster.projects.push(p.id);
    for (const b of buckets) {
      const key = b.name.trim().toLowerCase();
      cluster.bucketCounts.set(key, (cluster.bucketCounts.get(key) ?? 0) + 1);
    }
    clustersBySig.set(sig, cluster);
  }

  const eligible = Array.from(clustersBySig.entries())
    .filter(([, cluster]) => cluster.projects.length >= MIN_CLUSTER_SIZE)
    .sort((a, b) => b[1].projects.length - a[1].projects.length)
    .slice(0, 3);

  // Skip clusters that have already been saved as a template — match
  // on bucket-name set against existing quote_templates rows.
  const { data: existingTemplates } = await admin
    .from('quote_templates')
    .select('snapshot')
    .eq('tenant_id', tenant.id)
    .is('deleted_at', null);
  const existingSigs = new Set<string>();
  for (const t of (existingTemplates ?? []) as Array<{ snapshot: StarterTemplate }>) {
    const buckets = t.snapshot?.buckets ?? [];
    if (buckets.length === 0) continue;
    const sig = Array.from(new Set(buckets.map((b) => b.name.trim().toLowerCase())))
      .sort()
      .join('|');
    existingSigs.add(sig);
  }

  const out: TemplateSuggestionCluster[] = [];
  for (const [sig, cluster] of eligible) {
    if (existingSigs.has(sig)) continue;

    // Build a scaffold from the most-recent project in the cluster.
    // Future enhancement: take the union of buckets/lines across the
    // cluster instead of a single sample.
    const sampleProjectId = cluster.projects[0];
    const sampleBuckets = (bucketsByProject.get(sampleProjectId) ?? [])
      .slice()
      .sort((a, b) => a.display_order - b.display_order);
    const sampleLines = (linesByProject.get(sampleProjectId) ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order);
    const linesByBucketId = new Map<string, LineRow[]>();
    for (const l of sampleLines) {
      if (!l.budget_category_id) continue;
      const arr = linesByBucketId.get(l.budget_category_id) ?? [];
      arr.push(l);
      linesByBucketId.set(l.budget_category_id, arr);
    }

    const scaffold: StarterTemplate = {
      slug: '',
      label: titleCaseFromSig(sig),
      description: `Drafted from ${cluster.projects.length} similar projects you've quoted recently.`,
      buckets: sampleBuckets.map((b) => ({
        name: b.name,
        section: b.section,
        lines: (linesByBucketId.get(b.id) ?? []).map((l) => ({
          label: l.label,
          category: l.category as 'material' | 'labour' | 'sub' | 'equipment' | 'overhead',
          qty: l.qty,
          unit: l.unit,
        })),
      })),
    };

    out.push({
      cluster_id: hashString(sig),
      label: scaffold.label,
      description: scaffold.description,
      project_count: cluster.projects.length,
      sample_project_ids: cluster.projects.slice(0, 5),
      scaffold,
    });
  }

  return out;
}

const saveSuggestionSchema = z.object({
  cluster_id: z.string().min(1),
  label: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  visibility: z.enum(['private', 'tenant']),
  scaffold: z.unknown(),
});

/**
 * Save a suggested cluster as a quote_template row. The cluster_id is
 * passed through for telemetry; it doesn't gate uniqueness — the
 * existing quote_templates row check in getTemplateSuggestions
 * already filters out clusters that already have a template.
 */
export async function saveSuggestedTemplateAction(
  input: Record<string, unknown>,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const parsed = saveSuggestionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('quote_templates')
    .insert({
      tenant_id: tenant.id,
      label: parsed.data.label,
      description: parsed.data.description ?? null,
      visibility: parsed.data.visibility,
      snapshot: parsed.data.scaffold,
      source: 'henry_suggested',
      created_by: user.id,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Could not save template.' };
  }

  revalidatePath('/settings');
  return { ok: true, id: data.id };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleCaseFromSig(sig: string): string {
  // sig is "bathroom|cabinets|drywall|..." — pick a couple anchor
  // bucket names to form a label.
  const parts = sig.split('|').filter(Boolean);
  if (parts.length === 0) return 'Project pattern';
  // Prefer well-known room/section anchors when present.
  const anchors = ['bathroom', 'kitchen', 'basement', 'deck'];
  for (const a of anchors) {
    if (parts.some((p) => p.includes(a))) {
      return `${a.charAt(0).toUpperCase() + a.slice(1)}-style projects`;
    }
  }
  // Fallback: join first two bucket names.
  const top = parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return `${top.join(' + ')} pattern`;
}

function hashString(s: string): string {
  // Lightweight, deterministic; not a cryptographic hash.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}
