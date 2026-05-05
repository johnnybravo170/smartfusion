/**
 * Read-side helpers for intake_drafts. RLS handles tenant scoping —
 * the queries just call through the request-scoped client. Visual
 * artifacts are decorated with signed URLs at load time so the chip
 * row can render thumbnail previews. URLs are 1-hour TTL — long
 * enough for a review session, short enough that they don't leak.
 */

import type { ParsedIntake } from '@/lib/ai/intake-prompt';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { IntakeArtifact, IntakeAugmentation } from '@/server/actions/intake';

export type IntakeDraftStatus =
  | 'pending'
  | 'transcribing'
  | 'extracting'
  | 'rethinking'
  | 'ready'
  | 'failed';

/**
 * Per-artifact, transient signed URL added at load time. Not persisted.
 * `null` means the artifact is non-visual (audio) or signing failed —
 * the chip row falls back to its kind-icon-only rendering.
 */
export type IntakeArtifactWithUrl = IntakeArtifact & {
  signedUrl: string | null;
};

export type IntakeDraftRow = {
  id: string;
  status: IntakeDraftStatus;
  customer_name: string | null;
  pasted_text: string | null;
  transcript: string | null;
  artifacts: IntakeArtifactWithUrl[];
  augmentations: IntakeAugmentation[];
  ai_extraction: {
    v1: ParsedIntake | null;
    v2: ParsedIntake | null;
    active: 'v1' | 'v2';
  } | null;
  parsed_by: string | null;
  error_message: string | null;
  recognized_customer_id: string | null;
  accepted_project_id: string | null;
  created_at: string;
  updated_at: string;
};

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Load a single draft by id. Returns null when missing or
 * cross-tenant (RLS denies the row). Decorates visual artifacts
 * (image/* + application/pdf) with 1-hour signed URLs so the chip
 * row can render thumbnails.
 */
export async function loadIntakeDraft(id: string): Promise<IntakeDraftRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('intake_drafts')
    .select(
      'id, status, customer_name, pasted_text, transcript, artifacts, augmentations, ai_extraction, parsed_by, error_message, recognized_customer_id, accepted_project_id, created_at, updated_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;

  const rawArtifacts = ((data.artifacts as IntakeArtifact[] | null) ?? []).filter(
    (a): a is IntakeArtifact => !!a && typeof a.path === 'string' && a.path.length > 0,
  );
  const visualPaths = rawArtifacts
    .filter((a) => a.mime?.startsWith('image/') || a.mime === 'application/pdf')
    .map((a) => a.path);

  const urlByPath = new Map<string, string>();
  if (visualPaths.length > 0) {
    const admin = createAdminClient();
    const { data: signed } = await admin.storage
      .from('intake-audio')
      .createSignedUrls(visualPaths, SIGNED_URL_TTL_SECONDS);
    for (const entry of signed ?? []) {
      if (entry.path && entry.signedUrl) urlByPath.set(entry.path, entry.signedUrl);
    }
  }

  const artifacts: IntakeArtifactWithUrl[] = rawArtifacts.map((a) => ({
    ...a,
    signedUrl: urlByPath.get(a.path) ?? null,
  }));

  return { ...(data as unknown as IntakeDraftRow), artifacts };
}
