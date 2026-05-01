/**
 * Henry AI trigger hooks.
 *
 * Each helper here is fired from the closest server action's success path.
 * It inspects the relevant data and, when warranted, writes a
 * `henry_suggestion` notification row that surfaces in:
 *   - the next AI chat turn (the morning briefing tool returns these)
 *   - the nightly briefing (cron-driven; see /api/cron/henry-nightly)
 *
 * Henry never auto-creates tasks from triggers — these rows are
 * suggestions; the owner approves them. The only exception is the
 * existing lead-conversion auto-migration in createJobAction (Phase 3).
 *
 * Best-effort: we never fail the parent action if the suggestion write
 * trips. Logging only.
 */

import { createAdminClient } from '@/lib/supabase/admin';

type SuggestionInput = {
  tenantId: string;
  title: string;
  body: string;
  jobId?: string | null;
  taskId?: string | null;
  /** Owner/admin recipient. Null = broadcast to all owners/admins. */
  recipientUserId?: string | null;
};

async function writeHenrySuggestion(input: SuggestionInput): Promise<void> {
  try {
    const admin = createAdminClient();
    if (input.recipientUserId !== undefined) {
      await admin.from('notifications').insert({
        tenant_id: input.tenantId,
        recipient_user_id: input.recipientUserId,
        kind: 'henry_suggestion',
        task_id: input.taskId ?? null,
        job_id: input.jobId ?? null,
        title: input.title,
        body: input.body,
      });
      return;
    }
    // Broadcast: one row per owner/admin so each gets it in their inbox.
    const { data: members } = await admin
      .from('tenant_members')
      .select('user_id')
      .eq('tenant_id', input.tenantId)
      .in('role', ['owner', 'admin']);
    const rows = (members ?? []).map((m) => ({
      tenant_id: input.tenantId,
      recipient_user_id: m.user_id as string,
      kind: 'henry_suggestion' as const,
      task_id: input.taskId ?? null,
      job_id: input.jobId ?? null,
      title: input.title,
      body: input.body,
    }));
    if (rows.length > 0) await admin.from('notifications').insert(rows);
  } catch (e) {
    console.error('[henry-trigger] suggestion write failed:', e);
  }
}

/**
 * Fired when a quote (pressure-washing flow) is accepted.
 * Looks up the quote + customer name and suggests seeding tasks.
 */
export async function onQuoteApproved(quoteId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: quote } = await admin
      .from('quotes')
      .select('id, tenant_id, customers:customer_id (name)')
      .eq('id', quoteId)
      .maybeSingle();
    if (!quote) return;

    const customerRaw = (quote as Record<string, unknown>).customers as
      | { name: string }
      | { name: string }[]
      | null;
    const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
    const customerName = customer?.name ?? 'this customer';

    await writeHenrySuggestion({
      tenantId: quote.tenant_id as string,
      title: 'Quote approved — seed tasks?',
      body: `Quote for ${customerName} is approved. Want me to seed project tasks from the quote's scope categories?`,
    });
  } catch (e) {
    console.error('[henry-trigger] onQuoteApproved failed:', e);
  }
}

/**
 * Fired when an estimate (renovation/projects flow) is approved.
 * Mirrors onQuoteApproved but reads from the projects table.
 */
export async function onEstimateApproved(projectId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: project } = await admin
      .from('projects')
      .select('id, tenant_id, name')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) return;

    await writeHenrySuggestion({
      tenantId: project.tenant_id as string,
      title: 'Estimate approved — seed tasks?',
      body: `Estimate for "${project.name}" is approved. Want me to seed project tasks from the estimate scope categories?`,
    });
  } catch (e) {
    console.error('[henry-trigger] onEstimateApproved failed:', e);
  }
}

/** Fired when a change order is approved by the customer. */
export async function onChangeOrderApproved(coId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: co } = await admin
      .from('change_orders')
      .select('id, tenant_id, project_id, title')
      .eq('id', coId)
      .maybeSingle();
    if (!co) return;

    await writeHenrySuggestion({
      tenantId: co.tenant_id as string,
      title: 'Change order approved — create tasks?',
      body: `Change order "${co.title}" was accepted. Want me to create tasks for the new scope items?`,
    });
  } catch (e) {
    console.error('[henry-trigger] onChangeOrderApproved failed:', e);
  }
}

/**
 * Fired when a photo is uploaded against a job. If the job has any task
 * with required_photos=true currently in 'done' (waiting for verify),
 * suggest the photo might be the verification proof.
 */
export async function onPhotoUploaded(input: { jobId: string; photoId: string }): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: tasks } = await admin
      .from('tasks')
      .select('id, tenant_id, title, status, required_photos')
      .eq('job_id', input.jobId)
      .eq('required_photos', true)
      .eq('status', 'done');
    if (!tasks || tasks.length === 0) return;

    for (const t of tasks) {
      await writeHenrySuggestion({
        tenantId: t.tenant_id as string,
        jobId: input.jobId,
        taskId: t.id as string,
        title: 'Photo uploaded — verify task?',
        body: `Photo uploaded on this job. Does it complete task "${t.title}"?`,
      });
    }
  } catch (e) {
    console.error('[henry-trigger] onPhotoUploaded failed:', e);
  }
}

/**
 * Nightly: every task whose due_date < today and is still open gets
 * one suggestion. Idempotent within a 24h window — we skip if a
 * suggestion for the same task was already written in the last 24h.
 */
export async function nightlyOverdueScan(): Promise<{ written: number; checked: number }> {
  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: overdue } = await admin
    .from('tasks')
    .select('id, tenant_id, title, due_date, job_id')
    .lt('due_date', today)
    .not('status', 'in', '(done,verified)');

  const rows = overdue ?? [];
  let written = 0;
  for (const t of rows) {
    // Idempotency: was a suggestion already written for this task in the last 24h?
    const { data: prior } = await admin
      .from('notifications')
      .select('id')
      .eq('kind', 'henry_suggestion')
      .eq('task_id', t.id as string)
      .gte('created_at', since)
      .limit(1);
    if (prior && prior.length > 0) continue;

    const days = Math.max(
      1,
      Math.floor(
        (new Date(today).getTime() - new Date(t.due_date as string).getTime()) /
          (24 * 60 * 60 * 1000),
      ),
    );
    await writeHenrySuggestion({
      tenantId: t.tenant_id as string,
      taskId: t.id as string,
      jobId: (t.job_id as string | null) ?? null,
      title: 'Task overdue',
      body: `"${t.title}" was due ${days === 1 ? 'yesterday' : `${days} days ago`}. Reschedule or push to crew?`,
    });
    written++;
  }
  return { written, checked: rows.length };
}

/**
 * Nightly: leads with no contact_notes in the last 5 days and no
 * existing follow-up task. One suggestion per lead, idempotent within
 * 24h.
 */
export async function nightlyLeadUnansweredScan(): Promise<{
  written: number;
  checked: number;
}> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Pull all live leads with their last-contact timestamp.
  const { data: leads } = await admin
    .from('customers')
    .select('id, tenant_id, name, created_at')
    .eq('kind', 'lead')
    .is('deleted_at', null);

  const rows = leads ?? [];
  let written = 0;
  for (const lead of rows) {
    // Find last contact note for this lead (any author).
    const { data: notes } = await admin
      .from('contact_notes')
      .select('created_at')
      .eq('contact_id', lead.id as string)
      .order('created_at', { ascending: false })
      .limit(1);
    const lastTouch = notes?.[0]?.created_at ?? (lead.created_at as string) ?? null;
    if (!lastTouch) continue;
    if (lastTouch >= cutoff) continue; // touched within 5d, skip

    // Skip if a follow-up task already exists for this lead.
    const { data: existingTasks } = await admin
      .from('tasks')
      .select('id')
      .eq('lead_id', lead.id as string)
      .not('status', 'in', '(done,verified)')
      .limit(1);
    if (existingTasks && existingTasks.length > 0) continue;

    // Idempotency: skip if Henry already suggested in the last 24h.
    // We key on title+body containing the lead name; the cleanest signal
    // we have without a contact_id column on notifications.
    const { data: prior } = await admin
      .from('notifications')
      .select('id')
      .eq('kind', 'henry_suggestion')
      .eq('tenant_id', lead.tenant_id as string)
      .ilike('body', `%${lead.name as string}%`)
      .gte('created_at', since)
      .limit(1);
    if (prior && prior.length > 0) continue;

    await writeHenrySuggestion({
      tenantId: lead.tenant_id as string,
      title: 'Lead has gone quiet',
      body: `Lead "${lead.name}" — no contact in 5+ days. Add a follow-up task?`,
    });
    written++;
  }
  return { written, checked: rows.length };
}

// ---------------------------------------------------------------------------
// Deferred triggers (no upstream surface yet — flagged for a follow-up):
//   - Material delivery delayed: needs a `material_orders` table /
//     receiving flow. TODO(material-orders): wire `onMaterialDelayed`.
//   - Invoice milestone not met: needs a milestone surface on invoices.
//     TODO(invoice-milestones): wire `onMilestoneReached` to suggest
//     verification of pending tasks before send.
//   - Call transcript available: needs the call ingestion pipeline.
//     TODO(voice-transcripts): wire `onCallTranscriptReady` once the
//     transcript queue lands; should write a suggestion summarising
//     action items extracted from the transcript.
// ---------------------------------------------------------------------------
