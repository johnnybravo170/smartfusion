/**
 * Closeout orchestration — called when a job's status changes to 'complete'.
 *
 * Does five things:
 *   1. Ensures the tenant has a Closeout sequence + template (self-seeding,
 *      zero-config — Henry thinks so you don't have to)
 *   2. Picks the primary before/after pair for the email hero
 *   3. Creates (or reuses) a share link for the job
 *   4. Builds the signed URLs for the hero pair
 *   5. Emits a `job_completed` AR event with the payload as merge vars
 *
 * Runs inline after the job update commits. Best-effort: any failure is
 * logged but does NOT roll back the status change. Operators can always
 * re-trigger manually (Phase 4 will add a "Resend closeout" action).
 */

import { emitArEvent } from '@/lib/ar/event-bus';
import { getBusinessProfileAdmin, getPrimaryOperatorName } from '@/lib/db/queries/profile';
import { getSignedUrl } from '@/lib/storage/photos';
import { createAdminClient } from '@/lib/supabase/admin';
import { toAbsoluteUrl } from '@/lib/validators/profile';
import {
  buildCloseoutSequenceDef,
  buildCloseoutTemplate,
  buildLogoBlock,
  buildOperatorLine,
  buildReviewBlock,
} from './closeout-template';
import { buildShareUrl, getOrCreateShareLink, slugify } from './share-links';

type JobWithCustomer = {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer?: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    city: string | null;
  } | null;
  quote_id?: string | null;
};

type RunResult =
  | { ok: true; skipped: false; enrollmentsCreated: number; token: string }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string };

export async function handleJobCompleted(jobId: string): Promise<RunResult> {
  try {
    const admin = createAdminClient();

    const { data: job, error: jobErr } = await admin
      .from('jobs')
      .select(
        'id, tenant_id, customer_id, quote_id, customers:customer_id (id, name, email, phone, city)',
      )
      .eq('id', jobId)
      .maybeSingle();
    if (jobErr || !job) return { ok: false, error: `job_not_found: ${jobErr?.message ?? 'none'}` };

    const customerRaw =
      (job as JobWithCustomer).customer ?? (job as { customers?: unknown }).customers;
    const customer = Array.isArray(customerRaw)
      ? customerRaw[0]
      : (customerRaw as JobWithCustomer['customer']);

    if (!customer?.email) {
      return { ok: true, skipped: true, reason: 'no_customer_email' };
    }

    const tenantId = job.tenant_id as string;

    // 1. Ensure closeout setup for this tenant.
    const setup = await ensureCloseoutSetup(tenantId);
    if (!setup.sequenceId) {
      return { ok: false, error: `closeout_setup_failed: ${setup.error}` };
    }

    // 2. Pick the primary pair.
    const pair = await pickPrimaryPair(jobId);

    // 3. Create/reuse share link for the job.
    const { name: customerName } = splitName(customer.name ?? '');
    const customerSlug = slugify(customer.name ?? '') || null;
    const { token, slug } = await getOrCreateShareLink({
      tenantId,
      scopeType: 'job_full',
      scopeId: jobId,
      slug: customerSlug,
      label: `Closeout — ${customer.name ?? 'customer'}`,
      recipientEmail: customer.email,
      recipientPhone: customer.phone ?? null,
      recipientName: customer.name ?? null,
    });
    const galleryUrl = buildShareUrl({ token, slug });

    // 4. Sign the pair URLs (7 days — customer will view within that window).
    const [beforeUrl, afterUrl] = await Promise.all([
      pair?.beforePath ? getSignedUrl(pair.beforePath, 60 * 60 * 24 * 7) : Promise.resolve(null),
      pair?.afterPath ? getSignedUrl(pair.afterPath, 60 * 60 * 24 * 7) : Promise.resolve(null),
    ]);

    // 5. Resolve profile + surface details for the payload.
    const [business, operator, surfaceSummary] = await Promise.all([
      getBusinessProfileAdmin(tenantId),
      getPrimaryOperatorName(tenantId),
      resolveSurfaceSummary(job.quote_id ?? null),
    ]);

    const businessName = business?.name ?? 'Hey Henry';
    const reviewUrl = toAbsoluteUrl(business?.reviewUrl ?? null);
    const logoUrl = business?.logoSignedUrl ?? null;

    const logoHtml = buildLogoBlock(logoUrl);
    const reviewBlock = buildReviewBlock(reviewUrl);
    const operatorLine = buildOperatorLine(operator.firstName, operator.lastName, operator.title);

    // 6. Emit event.
    const { firstName, lastName } = splitName(customerName);
    const result = await emitArEvent({
      tenantId,
      eventType: 'job_completed',
      contact: {
        email: customer.email,
        phone: customer.phone ?? null,
        firstName,
        lastName,
      },
      payload: {
        job_id: jobId,
        first_name: firstName,
        last_name: lastName,
        business_name: businessName,
        surface_summary: surfaceSummary,
        city: customer.city ?? null,
        gallery_url: galleryUrl,
        primary_before_url: beforeUrl,
        primary_after_url: afterUrl,
        review_url: reviewUrl ?? galleryUrl,
        // Pre-rendered conditional blocks — the template is a flat merge.
        logo_html: logoHtml,
        review_html: reviewBlock.html,
        review_text: reviewBlock.text,
        operator_line_html: operatorLine.html,
        operator_line_text: operatorLine.text,
      },
    });

    return {
      ok: true,
      skipped: false,
      enrollmentsCreated: 0,
      token,
      ...result,
    } as unknown as RunResult;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Idempotent seeding — create the Closeout template and sequence for this
 * tenant if they don't exist yet. Running this on every Complete is cheap
 * because both lookups are indexed and bail after the first find.
 */
async function ensureCloseoutSetup(
  tenantId: string,
): Promise<{ sequenceId: string | null; templateId: string | null; error?: string }> {
  const admin = createAdminClient();

  // Fetch the tenant's sending identity. Fall back to the platform default.
  const { data: tenantRow } = await admin
    .from('tenants')
    .select('name')
    .eq('id', tenantId)
    .maybeSingle();
  const fromName = (tenantRow?.name as string | undefined) ?? 'Hey Henry';
  const fromEmail = process.env.RESEND_FROM_EMAIL
    ? extractEmail(process.env.RESEND_FROM_EMAIL)
    : 'noreply@heyhenry.io';
  const templateDef = buildCloseoutTemplate({ tenantId, fromName, fromEmail });

  // Existing Closeout template? Refresh its body from code so template edits
  // roll out to all tenants on next Complete. Customization will add a
  // "don't overwrite operator edits" flag later — noted in PHOTOS_PLAN.md.
  const { data: existingTpl } = await admin
    .from('ar_templates')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', 'Closeout — job complete')
    .maybeSingle();

  let templateId: string;
  if (existingTpl?.id) {
    templateId = existingTpl.id as string;
    const { error: updErr } = await admin
      .from('ar_templates')
      .update({
        subject: templateDef.subject,
        body_html: templateDef.bodyHtml,
        body_text: templateDef.bodyText,
        from_name: templateDef.fromName,
        from_email: templateDef.fromEmail,
        reply_to: templateDef.replyTo,
        updated_at: new Date().toISOString(),
      })
      .eq('id', templateId);
    if (updErr) return { sequenceId: null, templateId, error: updErr.message };
  } else {
    const { data: tpl, error: tplErr } = await admin
      .from('ar_templates')
      .insert({
        tenant_id: templateDef.tenantId,
        name: templateDef.name,
        channel: templateDef.channel,
        subject: templateDef.subject,
        body_html: templateDef.bodyHtml,
        body_text: templateDef.bodyText,
        from_name: templateDef.fromName,
        from_email: templateDef.fromEmail,
        reply_to: templateDef.replyTo,
      })
      .select('id')
      .single();
    if (tplErr || !tpl) return { sequenceId: null, templateId: null, error: tplErr?.message };
    templateId = tpl.id as string;
  }

  // Reuse an existing Closeout sequence if present. Creating a new sequence
  // each time would bloat ar_sequences on every Complete.
  const { data: existingSeq } = await admin
    .from('ar_sequences')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', 'Closeout')
    .maybeSingle();
  if (existingSeq?.id) {
    return { sequenceId: existingSeq.id as string, templateId };
  }

  // Sequence + step.
  const seqDef = buildCloseoutSequenceDef({ tenantId, templateId });
  const { data: seq, error: seqErr } = await admin
    .from('ar_sequences')
    .insert({
      tenant_id: seqDef.sequence.tenantId,
      name: seqDef.sequence.name,
      description: seqDef.sequence.description,
      status: seqDef.sequence.status,
      trigger_type: seqDef.sequence.triggerType,
      trigger_config: seqDef.sequence.triggerConfig,
      allow_reenrollment: seqDef.sequence.allowReenrollment,
    })
    .select('id, version')
    .single();
  if (seqErr || !seq) return { sequenceId: null, templateId, error: seqErr?.message };
  const sequenceId = seq.id as string;

  for (const step of seqDef.steps) {
    const { error: stepErr } = await admin.from('ar_steps').insert({
      sequence_id: sequenceId,
      version: seq.version as number,
      position: step.position,
      type: step.type,
      delay_minutes: step.delayMinutes,
      template_id: step.templateId,
    });
    if (stepErr) return { sequenceId, templateId, error: stepErr.message };
  }

  return { sequenceId, templateId };
}

/**
 * V1 pair picker — most recent 'after' photo + most recent 'before' photo
 * from the same job. Simple and predictable. Smarter heuristics (visual
 * contrast, subject matching) land in a later phase.
 */
async function pickPrimaryPair(
  jobId: string,
): Promise<{ beforePath: string | null; afterPath: string | null } | null> {
  const admin = createAdminClient();
  const [beforeRes, afterRes] = await Promise.all([
    admin
      .from('photos')
      .select('storage_path')
      .eq('job_id', jobId)
      .eq('tag', 'before')
      .is('deleted_at', null)
      .order('taken_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1),
    admin
      .from('photos')
      .select('storage_path')
      .eq('job_id', jobId)
      .eq('tag', 'after')
      .is('deleted_at', null)
      .order('taken_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  const beforePath = ((beforeRes.data ?? [])[0]?.storage_path as string | undefined) ?? null;
  const afterPath = ((afterRes.data ?? [])[0]?.storage_path as string | undefined) ?? null;
  if (!beforePath && !afterPath) return null;
  return { beforePath, afterPath };
}

async function resolveSurfaceSummary(quoteId: string | null): Promise<string> {
  if (!quoteId) return 'job';
  const admin = createAdminClient();
  const { data } = await admin
    .from('quote_line_items')
    .select('label')
    .eq('quote_id', quoteId)
    .order('sort_order', { ascending: true });
  const names = (data ?? [])
    .map((li) => humanizeSurface((li.label as string | null) ?? ''))
    .filter((v): v is string => Boolean(v));
  if (names.length === 0) return 'job';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function humanizeSurface(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.replace(/_/g, ' ');
}

function splitName(full: string): { firstName: string; lastName: string; name: string } {
  const trimmed = (full ?? '').trim();
  if (!trimmed) return { firstName: '', lastName: '', name: '' };
  const parts = trimmed.split(/\s+/);
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
    name: trimmed,
  };
}

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}
