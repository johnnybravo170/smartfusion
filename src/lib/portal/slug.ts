/**
 * Portal slug generation. Slugs are unguessable-ish project identifiers
 * used for the public customer portal URL (`/portal/[slug]`). Generated
 * lazily on first need: either when the operator enables the portal for
 * the first time, or when they open the Portal tab and we want to show
 * a preview link.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Returns the project's portal_slug, generating one if missing. Idempotent
 * — safe to call on every Portal tab render. Slug uniqueness is enforced
 * by the DB; we retry with a random suffix on collision (up to 3 times).
 *
 * Returns null only on hard error (project missing, repeated collision,
 * or DB error). Callers fall back to "no preview link available" UX.
 */
export async function ensurePortalSlug(
  supabase: SupabaseClient,
  projectId: string,
): Promise<string | null> {
  const { data: project } = await supabase
    .from('projects')
    .select('portal_slug, name')
    .eq('id', projectId)
    .single();
  if (!project) return null;
  const existing = (project.portal_slug as string | null) ?? null;
  if (existing) return existing;

  const base = slugify((project.name as string) ?? 'project') || 'project';
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { error } = await supabase
      .from('projects')
      .update({ portal_slug: slug, updated_at: new Date().toISOString() })
      .eq('id', projectId);
    if (!error) return slug;
    if (!error.message.includes('unique') && !error.message.includes('duplicate')) {
      return null;
    }
  }
  return null;
}
