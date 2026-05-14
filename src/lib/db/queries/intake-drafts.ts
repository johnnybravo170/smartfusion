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
import type {
  IntakeArtifact,
  IntakeArtifactKind,
  IntakeAugmentation,
} from '@/server/actions/intake';

/** Where this draft entered the system (intake_drafts.source). */
export type IntakeSource = 'email' | 'project_drop' | 'lead_form' | 'voice' | 'web_share';

/** Operator-action lifecycle (intake_drafts.disposition). */
export type IntakeDisposition = 'pending_review' | 'applied' | 'dismissed' | 'error';

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

/**
 * Compact row for the universal /inbox/intake list view. One per draft.
 * Includes envelope info from inbound_emails (when source='email') and
 * the FIRST visual artifact's signed URL for thumbnail rendering. The
 * full artifact list lives on the per-draft view.
 */
export type InboxIntakeRow = {
  id: string;
  source: IntakeSource;
  disposition: IntakeDisposition;
  status: IntakeDraftStatus;
  customer_name: string | null;
  primary_kind: IntakeArtifactKind | null;
  thumbnail_url: string | null;
  artifact_count: number;
  email_subject: string | null;
  email_from: string | null;
  accepted_project_id: string | null;
  recognized_customer_id: string | null;
  applied_at: string | null;
  created_at: string;
};

export type InboxIntakeFilter = {
  source?: IntakeSource;
  /** Default: pending_review + error. Pass 'all' to disable the filter. */
  disposition?: IntakeDisposition | 'all';
  /** Filter to drafts already accepted into a specific project. */
  projectId?: string;
  /** Free-text search against pasted_text + customer_name. */
  search?: string;
  /** Capped at 50 since each visual artifact gets a signed URL. */
  limit?: number;
};

/**
 * List drafts for the universal /inbox/intake view. LEFT-joins
 * inbound_emails for envelope preview (subject/from); non-email-source
 * drafts have nulls there.
 */
export async function listInboxIntake(filter: InboxIntakeFilter = {}): Promise<InboxIntakeRow[]> {
  const supabase = await createClient();
  const limit = Math.min(filter.limit ?? 50, 50);

  let query = supabase
    .from('intake_drafts')
    .select(
      `id, source, disposition, status, customer_name, pasted_text,
       artifacts, accepted_project_id, recognized_customer_id,
       applied_at, created_at,
       inbound_emails!intake_draft_id ( subject, from_address, from_name )`,
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (filter.source) query = query.eq('source', filter.source);

  if (filter.disposition && filter.disposition !== 'all') {
    query = query.eq('disposition', filter.disposition);
  } else if (!filter.disposition) {
    query = query.in('disposition', ['pending_review', 'error']);
  }

  if (filter.projectId) query = query.eq('accepted_project_id', filter.projectId);

  if (filter.search?.trim()) {
    const s = `%${filter.search.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    query = query.or(`pasted_text.ilike.${s},customer_name.ilike.${s}`);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  // Sign one thumbnail URL per row (the first visual artifact).
  const admin = createAdminClient();
  const firstVisualPaths: string[] = [];
  const draftToFirstVisual = new Map<string, string>();
  for (const row of data as Array<Record<string, unknown>>) {
    const artifacts = (row.artifacts as IntakeArtifact[] | null) ?? [];
    const visual = artifacts.find(
      (a) => a?.path && (a.mime?.startsWith('image/') || a.mime === 'application/pdf'),
    );
    if (visual?.path) {
      firstVisualPaths.push(visual.path);
      draftToFirstVisual.set(row.id as string, visual.path);
    }
  }
  const urlByPath = new Map<string, string>();
  if (firstVisualPaths.length > 0) {
    const { data: signed } = await admin.storage
      .from('intake-audio')
      .createSignedUrls(firstVisualPaths, SIGNED_URL_TTL_SECONDS);
    for (const entry of signed ?? []) {
      if (entry.path && entry.signedUrl) urlByPath.set(entry.path, entry.signedUrl);
    }
  }

  return (data as Array<Record<string, unknown>>).map((row) => {
    const artifacts = (row.artifacts as IntakeArtifact[] | null) ?? [];
    const primaryArtifact = artifacts[0] ?? null;
    const visualPath = draftToFirstVisual.get(row.id as string);
    const env =
      (row.inbound_emails as {
        subject: string | null;
        from_address: string | null;
        from_name: string | null;
      } | null) ?? null;
    return {
      id: row.id as string,
      source: row.source as IntakeSource,
      disposition: row.disposition as IntakeDisposition,
      status: row.status as IntakeDraftStatus,
      customer_name: (row.customer_name as string | null) ?? null,
      primary_kind: (primaryArtifact?.kind as IntakeArtifactKind | null) ?? null,
      thumbnail_url: visualPath ? (urlByPath.get(visualPath) ?? null) : null,
      artifact_count: artifacts.length,
      email_subject: env?.subject ?? null,
      email_from: env?.from_name
        ? `${env.from_name} <${env.from_address ?? ''}>`
        : (env?.from_address ?? null),
      accepted_project_id: (row.accepted_project_id as string | null) ?? null,
      recognized_customer_id: (row.recognized_customer_id as string | null) ?? null,
      applied_at: (row.applied_at as string | null) ?? null,
      created_at: row.created_at as string,
    };
  });
}
