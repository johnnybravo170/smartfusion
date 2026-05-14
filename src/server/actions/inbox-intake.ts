'use server';

/**
 * Inbox V2 — universal operator actions on intake_drafts.
 *
 * Five primitives that drive every per-row affordance on /inbox/intake,
 * regardless of where the draft entered the system (email forward, project
 * drop zone, lead form, voice memo, web share):
 *
 *   - applyIntakeIntentAction(draftId, { intent, projectId, fields })
 *       Dispatcher. Branches per intent, creates / links the destination
 *       row, stamps disposition='applied' + applied_destination_kind/id.
 *
 *   - editAppliedIntakeAction(draftId, { fields })
 *       Re-opens the destination row identified by applied_destination_*
 *       and updates whatever fields the per-intent dialog returned.
 *
 *   - moveAppliedIntakeAction(draftId, { newProjectId })
 *       Updates project_id on the destination row + accepted_project_id
 *       on the draft. Atomic from the operator's POV.
 *
 *   - undoIntakeApplyAction(draftId)
 *       Deletes the destination row, resets disposition='pending_review',
 *       clears applied_*. Permissive — single confirm at the UI layer,
 *       no lifecycle guards (paid/voided/etc.) in V2; V3 will add them.
 *
 *   - dismissIntakeAction / restoreDismissedIntakeAction
 *       Set / clear disposition='dismissed' without touching destination.
 *
 * Replaces the V1 surface (`confirmStagedBillAction`,
 * `linkInboundEmailToSubQuoteAction`, `reclassifyInboundEmailAction`).
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export type IntakeIntent =
  | 'vendor_bill'
  | 'sub_quote'
  | 'document'
  | 'photo'
  | 'message'
  | 'project';

export type IntakeActionResult = { ok: true; id: string } | { ok: false; error: string };

const INTAKE_BUCKET = 'intake-audio';
const PROJECT_DOCS_BUCKET = 'project-docs';
const PHOTOS_BUCKET = 'photos';

// ---------------------------------------------------------------------------
// Apply — dispatcher
// ---------------------------------------------------------------------------

const billFields = z.object({
  vendor: z.string().trim().min(1, 'Vendor is required.'),
  vendorGstNumber: z.string().trim().optional(),
  billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bill date must be YYYY-MM-DD.'),
  amountCents: z.coerce.number().int().min(0),
  gstCents: z.coerce.number().int().min(0).default(0),
  description: z.string().trim().optional(),
  budgetCategoryId: z.string().uuid().optional(),
  costLineId: z.string().uuid().optional(),
});
export type IntakeBillFields = z.input<typeof billFields>;

const subQuoteLinkFields = z.object({
  subQuoteId: z.string().uuid(),
});
export type IntakeSubQuoteFields = z.input<typeof subQuoteLinkFields>;

const documentFields = z.object({
  title: z.string().trim().min(1, 'Title is required.'),
  type: z.enum(['contract', 'permit', 'warranty', 'manual', 'inspection', 'coi', 'other']),
  notes: z.string().trim().optional(),
  /** Artifact path on intake-audio bucket to copy into project-docs. */
  artifactPath: z.string().min(1),
  artifactMime: z.string().optional(),
  artifactBytes: z.coerce.number().int().optional(),
});
export type IntakeDocumentFields = z.input<typeof documentFields>;

const photoFields = z.object({
  caption: z.string().trim().optional(),
  tag: z.enum(['before', 'after', 'progress', 'other']).default('other'),
  /** Artifact path on intake-audio bucket to copy into photos bucket. */
  artifactPath: z.string().min(1),
  artifactMime: z.string().optional(),
});
export type IntakePhotoFields = z.input<typeof photoFields>;

const messageFields = z.object({
  subject: z.string().trim().optional(),
  body: z.string().trim().min(1, 'Message body is required.'),
});
export type IntakeMessageFields = z.input<typeof messageFields>;

export type ApplyIntakeInput =
  | { draftId: string; intent: 'vendor_bill'; projectId: string; fields: IntakeBillFields }
  | { draftId: string; intent: 'sub_quote'; projectId: string; fields: IntakeSubQuoteFields }
  | { draftId: string; intent: 'document'; projectId: string; fields: IntakeDocumentFields }
  | { draftId: string; intent: 'photo'; projectId: string; fields: IntakePhotoFields }
  | { draftId: string; intent: 'message'; projectId: string; fields: IntakeMessageFields };

export async function applyIntakeIntentAction(
  input: ApplyIntakeInput,
): Promise<IntakeActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  // Verify the draft is loadable under RLS + still actionable.
  const { data: draft, error: draftErr } = await supabase
    .from('intake_drafts')
    .select('id, disposition')
    .eq('id', input.draftId)
    .maybeSingle();
  if (draftErr || !draft) return { ok: false, error: 'Intake draft not found.' };
  if (draft.disposition === 'applied') {
    return { ok: false, error: 'This item has already been applied. Undo first to re-route.' };
  }

  let destinationKind: 'vendor_bill' | 'sub_quote' | 'document' | 'photo' | 'message';
  let destinationId: string;

  switch (input.intent) {
    case 'vendor_bill': {
      const parsed = billFields.safeParse(input.fields);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid bill fields.' };
      }
      const f = parsed.data;
      const { data: bill, error } = await supabase
        .from('project_costs')
        .insert({
          tenant_id: tenant.id,
          project_id: input.projectId,
          vendor: f.vendor,
          vendor_gst_number: f.vendorGstNumber || null,
          cost_date: f.billDate,
          description: f.description || null,
          amount_cents: f.amountCents + f.gstCents,
          pre_tax_amount_cents: f.amountCents,
          gst_cents: f.gstCents,
          budget_category_id: f.budgetCategoryId || null,
          cost_line_id: f.costLineId || null,
          source_type: 'vendor_bill',
          payment_status: 'unpaid',
          status: 'active',
        })
        .select('id')
        .single();
      if (error || !bill) return { ok: false, error: error?.message ?? 'Bill insert failed.' };
      destinationKind = 'vendor_bill';
      destinationId = bill.id as string;
      break;
    }

    case 'sub_quote': {
      // The sub_quote row was already created by createSubQuoteAction (the
      // operator went through SubQuoteForm). We only stamp the linkage here.
      const parsed = subQuoteLinkFields.safeParse(input.fields);
      if (!parsed.success) {
        return { ok: false, error: 'Missing subQuoteId.' };
      }
      destinationKind = 'sub_quote';
      destinationId = parsed.data.subQuoteId;
      break;
    }

    case 'document': {
      const parsed = documentFields.safeParse(input.fields);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid document fields.' };
      }
      const f = parsed.data;
      const copied = await copyArtifactBetweenBuckets({
        fromBucket: INTAKE_BUCKET,
        toBucket: PROJECT_DOCS_BUCKET,
        sourcePath: f.artifactPath,
        tenantId: tenant.id,
        projectId: input.projectId,
        mime: f.artifactMime ?? 'application/octet-stream',
      });
      if (!copied.ok) return { ok: false, error: `Document copy failed: ${copied.error}` };

      const { data: doc, error } = await supabase
        .from('project_documents')
        .insert({
          tenant_id: tenant.id,
          project_id: input.projectId,
          type: f.type,
          title: f.title,
          storage_path: copied.path,
          mime: f.artifactMime ?? null,
          bytes: f.artifactBytes ?? null,
          notes: f.notes || null,
          uploaded_by: user.id,
        })
        .select('id')
        .single();
      if (error || !doc) {
        // Roll back the copied file so we don't leak.
        const admin = createAdminClient();
        await admin.storage
          .from(PROJECT_DOCS_BUCKET)
          .remove([copied.path])
          .catch(() => {});
        return { ok: false, error: error?.message ?? 'Document insert failed.' };
      }
      destinationKind = 'document';
      destinationId = doc.id as string;
      break;
    }

    case 'photo': {
      const parsed = photoFields.safeParse(input.fields);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid photo fields.' };
      }
      const f = parsed.data;
      const copied = await copyArtifactBetweenBuckets({
        fromBucket: INTAKE_BUCKET,
        toBucket: PHOTOS_BUCKET,
        sourcePath: f.artifactPath,
        tenantId: tenant.id,
        projectId: input.projectId,
        mime: f.artifactMime ?? 'image/jpeg',
      });
      if (!copied.ok) return { ok: false, error: `Photo copy failed: ${copied.error}` };

      const { data: photo, error } = await supabase
        .from('photos')
        .insert({
          tenant_id: tenant.id,
          project_id: input.projectId,
          storage_path: copied.path,
          tag: f.tag,
          caption: f.caption || null,
          mime: f.artifactMime ?? null,
        })
        .select('id')
        .single();
      if (error || !photo) {
        const admin = createAdminClient();
        await admin.storage
          .from(PHOTOS_BUCKET)
          .remove([copied.path])
          .catch(() => {});
        return { ok: false, error: error?.message ?? 'Photo insert failed.' };
      }
      destinationKind = 'photo';
      destinationId = photo.id as string;
      break;
    }

    case 'message': {
      const parsed = messageFields.safeParse(input.fields);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid message fields.' };
      }
      const f = parsed.data;
      const { data: msg, error } = await supabase
        .from('project_messages')
        .insert({
          tenant_id: tenant.id,
          project_id: input.projectId,
          sender_kind: 'operator',
          sender_user_id: user.id,
          channel: 'email',
          direction: 'inbound',
          subject: f.subject || null,
          body: f.body,
        })
        .select('id')
        .single();
      if (error || !msg) return { ok: false, error: error?.message ?? 'Message insert failed.' };
      destinationKind = 'message';
      destinationId = msg.id as string;
      break;
    }
  }

  // Stamp the draft.
  const now = new Date().toISOString();
  const { error: stampErr } = await supabase
    .from('intake_drafts')
    .update({
      disposition: 'applied',
      applied_at: now,
      applied_by: user.id,
      applied_destination_kind: destinationKind,
      applied_destination_id: destinationId,
      accepted_project_id: input.projectId,
    })
    .eq('id', input.draftId);
  if (stampErr) return { ok: false, error: `Draft stamp failed: ${stampErr.message}` };

  revalidatePath('/inbox/intake');
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: destinationId };
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export type EditIntakeInput =
  | { draftId: string; fields: Partial<IntakeBillFields> }
  | { draftId: string; fields: Partial<IntakeDocumentFields> }
  | {
      draftId: string;
      fields: { caption?: string; tag?: 'before' | 'after' | 'progress' | 'other' };
    }
  | { draftId: string; fields: { subject?: string; body?: string } };

export async function editAppliedIntakeAction(input: {
  draftId: string;
  fields: Record<string, unknown>;
}): Promise<IntakeActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: draft, error } = await supabase
    .from('intake_drafts')
    .select(
      'id, disposition, applied_destination_kind, applied_destination_id, accepted_project_id',
    )
    .eq('id', input.draftId)
    .maybeSingle();
  if (error || !draft) return { ok: false, error: 'Intake draft not found.' };
  if (draft.disposition !== 'applied' || !draft.applied_destination_id) {
    return { ok: false, error: 'Draft has no applied destination to edit.' };
  }

  const destId = draft.applied_destination_id as string;
  const f = input.fields;

  switch (draft.applied_destination_kind as string) {
    case 'vendor_bill': {
      const update: Record<string, unknown> = {};
      if (typeof f.vendor === 'string') update.vendor = f.vendor.trim();
      if (typeof f.vendorGstNumber === 'string')
        update.vendor_gst_number = f.vendorGstNumber.trim() || null;
      if (typeof f.billDate === 'string') update.cost_date = f.billDate;
      if (typeof f.description === 'string') update.description = f.description.trim() || null;
      if (typeof f.amountCents === 'number' || typeof f.gstCents === 'number') {
        // Reload current values so partial updates don't desync amount_cents.
        const { data: cur } = await supabase
          .from('project_costs')
          .select('pre_tax_amount_cents, gst_cents')
          .eq('id', destId)
          .single();
        const preTax =
          typeof f.amountCents === 'number'
            ? f.amountCents
            : ((cur?.pre_tax_amount_cents as number) ?? 0);
        const gst = typeof f.gstCents === 'number' ? f.gstCents : ((cur?.gst_cents as number) ?? 0);
        update.pre_tax_amount_cents = preTax;
        update.gst_cents = gst;
        update.amount_cents = preTax + gst;
      }
      if (typeof f.budgetCategoryId === 'string')
        update.budget_category_id = f.budgetCategoryId || null;
      const { error: upErr } = await supabase.from('project_costs').update(update).eq('id', destId);
      if (upErr) return { ok: false, error: upErr.message };
      break;
    }
    case 'document': {
      const update: Record<string, unknown> = {};
      if (typeof f.title === 'string') update.title = f.title.trim();
      if (typeof f.type === 'string') update.type = f.type;
      if (typeof f.notes === 'string') update.notes = f.notes.trim() || null;
      const { error: upErr } = await supabase
        .from('project_documents')
        .update(update)
        .eq('id', destId);
      if (upErr) return { ok: false, error: upErr.message };
      break;
    }
    case 'photo': {
      const update: Record<string, unknown> = {};
      if (typeof f.caption === 'string') update.caption = f.caption.trim() || null;
      if (typeof f.tag === 'string') update.tag = f.tag;
      const { error: upErr } = await supabase.from('photos').update(update).eq('id', destId);
      if (upErr) return { ok: false, error: upErr.message };
      break;
    }
    case 'message': {
      const update: Record<string, unknown> = {};
      if (typeof f.subject === 'string') update.subject = f.subject.trim() || null;
      if (typeof f.body === 'string') update.body = f.body.trim();
      const { error: upErr } = await supabase
        .from('project_messages')
        .update(update)
        .eq('id', destId);
      if (upErr) return { ok: false, error: upErr.message };
      break;
    }
    case 'sub_quote':
      return {
        ok: false,
        error:
          'Edit the vendor quote from the project Costs tab — V2 does not edit sub-quotes inline.',
      };
    default:
      return { ok: false, error: 'Unknown destination kind.' };
  }

  revalidatePath('/inbox/intake');
  if (draft.accepted_project_id) revalidatePath(`/projects/${draft.accepted_project_id}`);
  return { ok: true, id: destId };
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

export async function moveAppliedIntakeAction(input: {
  draftId: string;
  newProjectId: string;
}): Promise<IntakeActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: draft, error } = await supabase
    .from('intake_drafts')
    .select(
      'id, disposition, applied_destination_kind, applied_destination_id, accepted_project_id',
    )
    .eq('id', input.draftId)
    .maybeSingle();
  if (error || !draft) return { ok: false, error: 'Intake draft not found.' };
  if (draft.disposition !== 'applied' || !draft.applied_destination_id) {
    return { ok: false, error: 'Draft has no applied destination to move.' };
  }

  const destId = draft.applied_destination_id as string;
  const oldProjectId = draft.accepted_project_id as string | null;
  const table = destinationTable(draft.applied_destination_kind as string);
  if (!table) return { ok: false, error: 'Unknown destination kind.' };

  const { error: moveErr } = await supabase
    .from(table)
    .update({ project_id: input.newProjectId })
    .eq('id', destId);
  if (moveErr) return { ok: false, error: moveErr.message };

  const { error: draftErr } = await supabase
    .from('intake_drafts')
    .update({ accepted_project_id: input.newProjectId })
    .eq('id', input.draftId);
  if (draftErr) return { ok: false, error: draftErr.message };

  revalidatePath('/inbox/intake');
  if (oldProjectId) revalidatePath(`/projects/${oldProjectId}`);
  revalidatePath(`/projects/${input.newProjectId}`);
  return { ok: true, id: destId };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export async function undoIntakeApplyAction(draftId: string): Promise<IntakeActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: draft, error } = await supabase
    .from('intake_drafts')
    .select(
      'id, disposition, applied_destination_kind, applied_destination_id, accepted_project_id',
    )
    .eq('id', draftId)
    .maybeSingle();
  if (error || !draft) return { ok: false, error: 'Intake draft not found.' };
  if (draft.disposition !== 'applied' || !draft.applied_destination_id) {
    return { ok: false, error: 'Draft is not applied — nothing to undo.' };
  }

  const destId = draft.applied_destination_id as string;
  const projectId = draft.accepted_project_id as string | null;
  const kind = draft.applied_destination_kind as string;
  const table = destinationTable(kind);

  if (table) {
    // For document/photo, also delete the file from its bucket. project_costs
    // and project_messages have no separate file ownership we need to clean.
    if (kind === 'document') {
      const { data: doc } = await supabase
        .from('project_documents')
        .select('storage_path')
        .eq('id', destId)
        .maybeSingle();
      const path = (doc?.storage_path as string | null) ?? null;
      if (path) {
        const admin = createAdminClient();
        await admin.storage
          .from(PROJECT_DOCS_BUCKET)
          .remove([path])
          .catch(() => {});
      }
    } else if (kind === 'photo') {
      const { data: ph } = await supabase
        .from('photos')
        .select('storage_path')
        .eq('id', destId)
        .maybeSingle();
      const path = (ph?.storage_path as string | null) ?? null;
      if (path) {
        const admin = createAdminClient();
        await admin.storage
          .from(PHOTOS_BUCKET)
          .remove([path])
          .catch(() => {});
      }
    }
    const { error: delErr } = await supabase.from(table).delete().eq('id', destId);
    if (delErr) return { ok: false, error: delErr.message };
  }
  // For sub_quote we don't delete the destination — V2 keeps the quote
  // and only unlinks the draft (the quote may already be referenced
  // elsewhere). V3 will add guard rails.

  const { error: resetErr } = await supabase
    .from('intake_drafts')
    .update({
      disposition: 'pending_review',
      applied_at: null,
      applied_by: null,
      applied_destination_kind: null,
      applied_destination_id: null,
    })
    .eq('id', draftId);
  if (resetErr) return { ok: false, error: resetErr.message };

  revalidatePath('/inbox/intake');
  if (projectId) revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: draftId };
}

// ---------------------------------------------------------------------------
// Dismiss / restore
// ---------------------------------------------------------------------------

export async function dismissIntakeAction(draftId: string): Promise<IntakeActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('intake_drafts')
    .update({ disposition: 'dismissed' })
    .eq('id', draftId)
    .eq('disposition', 'pending_review'); // can only dismiss pending rows; applied undo first
  if (error) return { ok: false, error: error.message };
  revalidatePath('/inbox/intake');
  return { ok: true, id: draftId };
}

export async function restoreDismissedIntakeAction(draftId: string): Promise<IntakeActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('intake_drafts')
    .update({ disposition: 'pending_review' })
    .eq('id', draftId)
    .eq('disposition', 'dismissed');
  if (error) return { ok: false, error: error.message };
  revalidatePath('/inbox/intake');
  return { ok: true, id: draftId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function destinationTable(kind: string): string | null {
  switch (kind) {
    case 'vendor_bill':
      return 'project_costs';
    case 'document':
      return 'project_documents';
    case 'photo':
      return 'photos';
    case 'message':
      return 'project_messages';
    case 'sub_quote':
      return 'project_sub_quotes';
    default:
      return null;
  }
}

type CopyResult = { ok: true; path: string } | { ok: false; error: string };

async function copyArtifactBetweenBuckets(args: {
  fromBucket: string;
  toBucket: string;
  sourcePath: string;
  tenantId: string;
  projectId: string;
  mime: string;
}): Promise<CopyResult> {
  const admin = createAdminClient();
  const { data: blob, error: dlErr } = await admin.storage
    .from(args.fromBucket)
    .download(args.sourcePath);
  if (dlErr || !blob) return { ok: false, error: dlErr?.message ?? 'Source not found.' };

  // Extension from MIME or path tail.
  const ext = (() => {
    const tail = args.sourcePath.split('.').pop();
    if (tail && tail.length <= 5) return tail;
    if (args.mime === 'application/pdf') return 'pdf';
    if (args.mime === 'image/png') return 'png';
    if (args.mime === 'image/webp') return 'webp';
    if (args.mime === 'image/heic' || args.mime === 'image/heif') return 'heic';
    return 'bin';
  })();

  const destPath = `${args.tenantId}/${args.projectId}/${crypto.randomUUID()}.${ext}`;
  const buf = Buffer.from(await blob.arrayBuffer());
  const { error: upErr } = await admin.storage
    .from(args.toBucket)
    .upload(destPath, buf, { contentType: args.mime, upsert: false });
  if (upErr) return { ok: false, error: upErr.message };
  return { ok: true, path: destPath };
}
