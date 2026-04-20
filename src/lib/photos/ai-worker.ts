/**
 * Photo AI classification worker.
 *
 * Claims a small batch of unprocessed photos, runs Claude Vision on each,
 * and writes back (ai_tag, ai_caption, confidence, quality_flags). Applies
 * the "silent apply" threshold (default 0.85, overridable per tenant) to
 * also populate the canonical `tag` and `caption` fields when Henry is
 * confident enough.
 *
 * Claim safety: we use `ai_attempts` as an optimistic increment. Two workers
 * firing concurrently (e.g. cron overlap) can't both process the same photo
 * because the second will read a higher ai_attempts than it wrote. Cheap,
 * no FOR UPDATE needed since cron frequency keeps contention near zero.
 */

import { getPrefs } from '@/lib/prefs/tenant-prefs';
import { createAdminClient } from '@/lib/supabase/admin';
import { type ClassifierPrefs, classifyPhoto } from './ai-classifier';

const CLAIM_BATCH = 5;
const MAX_ATTEMPTS = 3;
const DEFAULT_SILENT_APPLY = 0.85;
const STORAGE_BUCKET = 'photos';
const SIGN_SECONDS = 60 * 5;

type PhotoRow = {
  id: string;
  tenant_id: string;
  job_id: string | null;
  storage_path: string;
  tag: string;
  caption: string | null;
  mime: string | null;
  taken_at: string | null;
  ai_attempts: number;
};

type JobContextRow = {
  status: string | null;
  scheduled_at: string | null;
  customer_id: string | null;
  quote_id: string | null;
};

export async function runPhotoAiWorker(): Promise<{
  processed: number;
  applied: number;
  softApplied: number;
  errored: number;
  skipped: number;
}> {
  const admin = createAdminClient();

  const { data: photos, error } = await admin
    .from('photos')
    .select('id, tenant_id, job_id, storage_path, tag, caption, mime, taken_at, ai_attempts')
    .is('ai_processed_at', null)
    .is('deleted_at', null)
    .lt('ai_attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(CLAIM_BATCH);
  if (error) throw new Error(`claim_failed: ${error.message}`);
  if (!photos || photos.length === 0) {
    return { processed: 0, applied: 0, softApplied: 0, errored: 0, skipped: 0 };
  }

  let applied = 0;
  let softApplied = 0;
  let errored = 0;
  let skipped = 0;

  for (const photo of photos as PhotoRow[]) {
    try {
      const result = await processOne(photo);
      if (result === 'applied') applied++;
      else if (result === 'soft_applied') softApplied++;
      else skipped++;
    } catch (e) {
      errored++;
      const message = e instanceof Error ? e.message : String(e);
      await admin
        .from('photos')
        .update({
          ai_attempts: photo.ai_attempts + 1,
          ai_last_attempt_at: new Date().toISOString(),
          ai_last_error: message.slice(0, 500),
        })
        .eq('id', photo.id);
    }
  }

  return { processed: photos.length, applied, softApplied, errored, skipped };
}

async function processOne(photo: PhotoRow): Promise<'applied' | 'soft_applied' | 'skipped'> {
  const admin = createAdminClient();

  // Bump attempts first so a concurrent worker or a crash-and-retry doesn't
  // loop forever on the same photo.
  await admin
    .from('photos')
    .update({
      ai_attempts: photo.ai_attempts + 1,
      ai_last_attempt_at: new Date().toISOString(),
    })
    .eq('id', photo.id);

  // Fetch image bytes via signed URL
  const { data: signed, error: signErr } = await admin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(photo.storage_path, SIGN_SECONDS);
  if (signErr || !signed?.signedUrl) {
    throw new Error(`sign_url_failed: ${signErr?.message ?? 'no_url'}`);
  }
  const imgRes = await fetch(signed.signedUrl);
  if (!imgRes.ok) throw new Error(`image_fetch_${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const contentType = imgRes.headers.get('content-type') ?? photo.mime ?? 'image/jpeg';

  // Gather context
  const [jobContext, tenantVertical, prefs] = await Promise.all([
    loadJobContext(photo.job_id),
    loadTenantVertical(photo.tenant_id),
    getPrefs<ClassifierPrefs & { silentApplyThreshold?: number }>(photo.tenant_id, 'photos'),
  ]);

  let surfaces: string[] = [];
  let customerCity: string | null = null;
  if (jobContext?.quote_id) {
    const { data: items } = await admin
      .from('quote_line_items')
      .select('label')
      .eq('quote_id', jobContext.quote_id)
      .order('sort_order', { ascending: true });
    surfaces = (items ?? []).map((li) => li.label as string).filter(Boolean);
  }
  if (jobContext?.customer_id) {
    const { data: cust } = await admin
      .from('customers')
      .select('city')
      .eq('id', jobContext.customer_id)
      .maybeSingle();
    customerCity = (cust?.city as string | null) ?? null;
  }

  const result = await classifyPhoto({
    imageBytes: buf,
    mimeType: contentType,
    context: {
      vertical: tenantVertical,
      jobStatus: jobContext?.status ?? null,
      surfaces,
      customerCity,
      scheduledAt: jobContext?.scheduled_at ?? null,
      takenAt: photo.taken_at,
    },
    prefs,
  });

  const silentApply = prefs.silentApplyThreshold ?? DEFAULT_SILENT_APPLY;

  // Decide whether to silently apply to the canonical `tag` / `caption`
  // fields, or just populate the ai_* fields for operator review.
  const shouldApplyTag = result.tagConfidence >= silentApply && photo.tag === 'other';
  const shouldApplyCaption =
    result.captionConfidence >= silentApply && (!photo.caption || photo.caption.trim() === '');

  const update: Record<string, unknown> = {
    ai_tag: result.tag,
    ai_tag_confidence: result.tagConfidence,
    ai_caption: result.caption,
    ai_caption_confidence: result.captionConfidence,
    quality_flags: result.qualityFlags,
    ai_processed_at: new Date().toISOString(),
    ai_last_error: null,
  };
  if (shouldApplyTag) update.tag = result.tag;
  if (shouldApplyCaption) {
    update.caption = result.caption;
    update.caption_source = 'ai';
  }

  const { error: updErr } = await admin.from('photos').update(update).eq('id', photo.id);
  if (updErr) throw new Error(`update_failed: ${updErr.message}`);

  if (shouldApplyTag || shouldApplyCaption) return 'applied';
  return 'soft_applied';
}

async function loadJobContext(jobId: string | null): Promise<JobContextRow | null> {
  if (!jobId) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('jobs')
    .select('status, scheduled_at, customer_id, quote_id')
    .eq('id', jobId)
    .maybeSingle();
  if (error) return null;
  return data as JobContextRow | null;
}

async function loadTenantVertical(tenantId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('tenants')
    .select('vertical')
    .eq('id', tenantId)
    .maybeSingle();
  if (error || !data) return null;
  return (data.vertical as string | null) ?? null;
}
