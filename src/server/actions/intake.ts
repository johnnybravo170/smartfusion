'use server';

/**
 * Inbound lead intake.
 *
 * `parseInboundLeadAction` runs Whisper over any voice memos, then
 * Opus / GPT-4.1 over the resulting transcript + screenshots / photos.
 * It returns a draft estimate the operator can review. It does NOT
 * mutate any project state.
 *
 * Every run persists to `intake_drafts` (migration 0176). The row
 * captures customer name, pasted text, transcript, ai_extraction
 * (envelope-shaped {v1,v2,active} for the second-pass thinking button
 * once it's wired), parsed_by, status, and error_message. This means:
 *
 *   - Stage B (Opus parse) can fail without losing the transcript
 *   - `parseIntakeDraftAction(draftId)` retries Stage B against the
 *     persisted transcript without re-Whispering
 *   - Every successful intake leaves a fixture for the eval set
 *
 * `acceptInboundLeadAction` takes the (possibly edited) draft and
 * creates the customer, project, budget categories, and cost lines.
 * Reference-photo upload to project storage is intentionally out of
 * scope here — the operator can attach photos to lines after creation
 * through the existing photo strip UI.
 */

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import {
  INTAKE_JSON_SCHEMA,
  INTAKE_SYSTEM_PROMPT,
  type ParsedIntake,
} from '@/lib/ai/intake-prompt';
import { type AttachedFile, gateway, isAiError } from '@/lib/ai-gateway';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { type ContactMatch, findContactMatches } from '@/lib/db/queries/contact-matches';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 12;
// gpt-4.1 (OpenAI) — was gpt-4o-mini. mini consistently undershot on
// long conversational transcripts; gpt-4.1 is materially better at
// multi-category decomposition and quantity disambiguation across
// context-heavy inputs. Pennies more per intake call; much higher
// completeness.
const PARSE_MODEL = 'gpt-4.1';
// Opus (Anthropic) — highest-reasoning task in the app. Multimodal
// (audio transcript + images + PDFs), domain inference, supply/install
// decomposition, implicit upsell extraction, human-voice reply gen.
// ~25¢/call vs ~5¢ on Sonnet — fine for a feature that runs once per
// inbound lead.
const CLAUDE_PARSE_MODEL = 'claude-opus-4-5';

export type ParseModelChoice = 'gpt-4.1' | 'claude-sonnet';

export type ParseInboundResult =
  | {
      ok: true;
      /**
       * The persisted intake_drafts row id. Carries through accept so we
       * can mark accepted_project_id once the project is created.
       */
      draftId: string;
      draft: ParsedIntake;
      /**
       * Concatenated Whisper transcript(s) from any audio attachments.
       * Surfaced on the review screen so the operator can see what the
       * model actually heard — invaluable when the categories come back
       * thin and you need to diagnose whether the audio was unclear or
       * the extraction was lazy.
       */
      transcript: string | null;
      /**
       * Exact model id that produced this draft. Surfaced on the review
       * screen so any screenshot / PDF the operator captures is self-
       * labelled — no more "wait, was that Opus or Sonnet?".
       */
      parsedBy: string;
    }
  | {
      ok: false;
      error: string;
      /**
       * Set when the draft row was created but a later stage failed.
       * The caller can hand this to `parseIntakeDraftAction` to retry
       * the parse against the persisted transcript without burning
       * Whisper again.
       */
      draftId?: string;
    };

type IntakeExtractionEnvelope = {
  v1: ParsedIntake | null;
  v2: ParsedIntake | null;
  active: 'v1' | 'v2';
};

export async function parseInboundLeadAction(
  formData: FormData,
  options?: { model?: ParseModelChoice },
): Promise<ParseInboundResult> {
  const modelChoice: ParseModelChoice = options?.model ?? 'gpt-4.1';
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const customerName = String(formData.get('customerName') ?? '').trim();
  let pastedText = String(formData.get('pastedText') ?? '').trim();

  // Every file rides via Supabase Storage now — the client uploads to
  // the `intake-audio` storage bucket (the name is historical; it stages
  // images + PDFs too) and we get only the storage entries here. Vercel
  // caps server-action bodies around 4.5 MB, so two photos or one voice
  // memo in the body killed the request before the action even ran.
  // Each entry carries the storage path + the original filename so the
  // prompt can use names like "Tony flooding job. 2452 mountain
  // drive.m4a" to extract customer / address context.
  const storageEntries: Array<{ path: string; name: string }> = [];
  for (const entry of formData.getAll('storageEntries')) {
    if (typeof entry !== 'string') continue;
    try {
      const parsed = JSON.parse(entry) as { path?: unknown; name?: unknown };
      if (typeof parsed.path === 'string' && parsed.path.length > 0) {
        storageEntries.push({
          path: parsed.path,
          name: typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : 'file',
        });
      }
    } catch {
      // Ignore malformed entry — better to drop one artifact than fail the whole intake.
    }
  }

  if (!customerName && !pastedText && storageEntries.length === 0) {
    return { ok: false, error: 'Need at least an image, pasted text, or a customer name.' };
  }
  if (storageEntries.length > MAX_IMAGES) {
    return { ok: false, error: `Too many files (max ${MAX_IMAGES}).` };
  }

  // Create the persisted draft row up front. Every state transition
  // below writes to this row so a Stage B failure (Opus timeout, rate
  // limit, etc.) doesn't lose the transcript — the operator can retry
  // via parseIntakeDraftAction(draftId) against the persisted state.
  const supabaseRls = await createClient();
  const { data: draftRow, error: draftErr } = await supabaseRls
    .from('intake_drafts')
    .insert({
      tenant_id: tenant.id,
      status: 'pending',
      customer_name: customerName || null,
      pasted_text: pastedText || null,
    })
    .select('id')
    .single();
  if (draftErr || !draftRow) {
    return { ok: false, error: `Failed to create intake draft: ${draftErr?.message ?? 'unknown'}` };
  }
  const draftId = draftRow.id as string;
  const updateDraft = async (patch: Record<string, unknown>) => {
    await supabaseRls.from('intake_drafts').update(patch).eq('id', draftId);
  };

  // Download each staged file via the service-role client (bypasses RLS
  // — the storage bucket is auth-scoped but the admin client skips that). Audio
  // goes to Whisper and its transcript is folded into pastedText AND
  // collected into transcriptParts so it can be surfaced on the review
  // screen for diagnosis. Images + PDFs collect into `files` for the
  // downstream vision pass. Best-effort cleanup of each staging file.
  const files: File[] = [];
  const transcriptParts: string[] = [];
  const hasAudio = storageEntries.some(({ name }) =>
    /\.(m4a|mp3|mp4|wav|webm|ogg|aac|flac)$/i.test(name),
  );
  if (hasAudio) await updateDraft({ status: 'transcribing' });
  if (storageEntries.length > 0) {
    const admin = createAdminClient();
    for (const { path, name: originalName } of storageEntries) {
      const { data: blob, error: dlErr } = await admin.storage.from('intake-audio').download(path);
      if (dlErr || !blob) continue;
      if (blob.size > MAX_BYTES) {
        await admin.storage.from('intake-audio').remove([path]);
        return { ok: false, error: `A staged file is larger than 25MB.` };
      }
      const type = blob.type || 'application/octet-stream';
      const f = new File([blob], originalName, { type });
      if (type.startsWith('audio/')) {
        let transcript: string;
        try {
          transcript = await transcribeAudio(f, tenant.id);
        } catch (err) {
          // Surface the Whisper error to the operator AS the result of
          // the action — never let it bubble to the page error boundary
          // (the user gets a useless "page hit an error" screen) or get
          // swallowed (the parser then invents a "screenshots didn't
          // come through" reply). Capture to Sentry so we still see it.
          await admin.storage
            .from('intake-audio')
            .remove([path])
            .catch(() => {});
          const detail = isAiError(err)
            ? `${err.kind}${err.kind === 'quota' ? ' — top up OpenAI credits or raise the project budget cap' : ''}`
            : err instanceof Error
              ? err.message
              : String(err);
          Sentry.captureException(err, {
            tags: { stage: 'intake.transcribe', task: 'audio_transcribe_intake' },
            extra: { filename: originalName, draftId },
          });
          await updateDraft({
            status: 'failed',
            error_message: `Transcription failed: ${detail}`,
          });
          return {
            ok: false,
            error: `Voice memo couldn't be transcribed: ${detail}. The artifact has been cleared — try again once resolved.`,
            draftId,
          };
        }
        if (transcript) {
          // Label the transcript with the original filename. The filename
          // frequently carries the customer's name and address ("Tony
          // flooding job. 2452 mountain drive.m4a") which the downstream
          // prompt can then extract into structured fields.
          const label = `Voice memo transcript (file: "${originalName}"):`;
          const block = `${label}\n${transcript}`;
          pastedText = pastedText ? `${pastedText}\n\n${block}` : block;
          transcriptParts.push(`${originalName}\n\n${transcript}`);
        }
      } else if (type.startsWith('image/') || type === 'application/pdf') {
        files.push(f);
      }
      await admin.storage.from('intake-audio').remove([path]);
    }
  }
  const transcript = transcriptParts.length > 0 ? transcriptParts.join('\n\n---\n\n') : null;
  await updateDraft({ status: 'extracting', transcript });

  // Build the prompt + the typed file list.
  const intro = [
    `Tenant: ${tenant.name ?? 'Contractor'}`,
    `Customer (operator-supplied): ${customerName || '(not provided)'}`,
    pastedText
      ? `Pasted message text:\n${pastedText}`
      : '(No pasted text — extract everything from the screenshots.)',
    files.length
      ? `${files.length} artifact(s) follow (images and/or PDFs), indexed 0..${files.length - 1}.`
      : '(No artifacts.)',
  ].join('\n\n');

  const attachedFiles: AttachedFile[] = [];
  for (const f of files) {
    const buf = Buffer.from(await f.arrayBuffer());
    attachedFiles.push({
      mime: f.type,
      base64: buf.toString('base64'),
      filename: f.name || undefined,
    });
  }

  // Operator's model choice maps to a gateway provider override.
  // Default `gpt-4.1` → OpenAI; `claude-sonnet` → Anthropic (Opus
  // primary per CLAUDE_PARSE_MODEL). Same prompt, same schema, lets
  // us A/B parse quality without redeploying.
  const provider_override = modelChoice === 'claude-sonnet' ? 'anthropic' : 'openai';
  const model_override = modelChoice === 'claude-sonnet' ? CLAUDE_PARSE_MODEL : PARSE_MODEL;

  let draft: ParsedIntake;
  try {
    const res = await gateway().runStructured<ParsedIntake>({
      kind: 'structured',
      task: 'intake_full_parse',
      tenant_id: tenant.id,
      provider_override,
      model_override,
      prompt: `${INTAKE_SYSTEM_PROMPT}\n\n${intro}`,
      schema: INTAKE_JSON_SCHEMA.schema,
      files: attachedFiles,
      temperature: 0.2,
      max_tokens: 8000,
    });
    draft = res.data;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { stage: 'intake.parse', task: 'intake_full_parse' },
      extra: { draftId, model_override, provider_override },
    });
    let userMessage: string;
    if (isAiError(err)) {
      if (err.kind === 'quota') userMessage = 'Intake parsing temporarily unavailable.';
      else if (err.kind === 'overload' || err.kind === 'rate_limit')
        userMessage = 'Intake parsing is busy right now. Try again in a moment.';
      else userMessage = `Intake parse failed: ${err.message}`;
    } else {
      userMessage = `Intake parse failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await updateDraft({ status: 'failed', error_message: userMessage });
    return { ok: false, error: userMessage, draftId };
  }

  // If operator typed a customer name, prefer it over whatever the model
  // pulled from the messages.
  if (customerName) draft.customer.name = customerName;

  // Persist the extraction in the same envelope shape used by
  // project_memos (migration 0174). Lets the second-pass / thinking
  // button drop in unchanged when we wire it for intake.
  const envelope: IntakeExtractionEnvelope = { v1: draft, v2: null, active: 'v1' };
  await updateDraft({
    status: 'ready',
    ai_extraction: envelope,
    parsed_by: model_override,
  });

  return { ok: true, draftId, draft, transcript, parsedBy: model_override };
}

/**
 * Stage B retry — re-runs the parse against the persisted transcript +
 * pasted text on a draft row. Used after a parse failure (timeout, rate
 * limit, transient model error) so the operator can recover without
 * re-uploading audio + paying for Whisper again.
 *
 * Photos / PDFs are NOT retried in this slice — those weren't persisted
 * past the original action. If the operator needs them on the retry,
 * they should re-upload via the normal flow (which creates a fresh
 * draft). Acceptable trade for the simplicity gain; revisit if it
 * matters in practice.
 */
export async function parseIntakeDraftAction(
  draftId: string,
  options?: { model?: ParseModelChoice },
): Promise<ParseInboundResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: row, error: loadErr } = await supabase
    .from('intake_drafts')
    .select('id, tenant_id, status, customer_name, pasted_text, transcript, ai_extraction')
    .eq('id', draftId)
    .maybeSingle();
  if (loadErr || !row) return { ok: false, error: 'Draft not found.' };

  const customerName = (row.customer_name as string | null)?.trim() ?? '';
  const transcript = (row.transcript as string | null)?.trim() ?? '';
  const pasted = (row.pasted_text as string | null)?.trim() ?? '';
  if (!transcript && !pasted) {
    return {
      ok: false,
      error: 'Draft has no transcript or pasted text to retry — re-upload via the form.',
      draftId,
    };
  }

  const modelChoice: ParseModelChoice = options?.model ?? 'gpt-4.1';
  const provider_override = modelChoice === 'claude-sonnet' ? 'anthropic' : 'openai';
  const model_override = modelChoice === 'claude-sonnet' ? CLAUDE_PARSE_MODEL : PARSE_MODEL;

  await supabase
    .from('intake_drafts')
    .update({ status: 'extracting', error_message: null })
    .eq('id', draftId);

  const transcriptBlock = transcript ? `Voice memo transcript:\n${transcript}` : '';
  const pastedBlock = pasted ? `Pasted message text:\n${pasted}` : '';
  const intro = [
    `Tenant: ${tenant.name ?? 'Contractor'}`,
    `Customer (operator-supplied): ${customerName || '(not provided)'}`,
    [transcriptBlock, pastedBlock].filter(Boolean).join('\n\n') ||
      '(No transcript or pasted text — degraded retry.)',
    '(No artifacts on retry — photos/PDFs from the original upload were not persisted.)',
  ].join('\n\n');

  let draft: ParsedIntake;
  try {
    const res = await gateway().runStructured<ParsedIntake>({
      kind: 'structured',
      task: 'intake_full_parse',
      tenant_id: tenant.id,
      provider_override,
      model_override,
      prompt: `${INTAKE_SYSTEM_PROMPT}\n\n${intro}`,
      schema: INTAKE_JSON_SCHEMA.schema,
      temperature: 0.2,
      max_tokens: 8000,
    });
    draft = res.data;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { stage: 'intake.reparse', task: 'intake_full_parse' },
      extra: { draftId, model_override, provider_override },
    });
    const message =
      isAiError(err) && err.kind === 'quota'
        ? 'Intake parsing temporarily unavailable.'
        : isAiError(err) && (err.kind === 'overload' || err.kind === 'rate_limit')
          ? 'Intake parsing is busy right now. Try again in a moment.'
          : `Intake parse failed: ${err instanceof Error ? err.message : String(err)}`;
    await supabase
      .from('intake_drafts')
      .update({ status: 'failed', error_message: message })
      .eq('id', draftId);
    return { ok: false, error: message, draftId };
  }

  if (customerName) draft.customer.name = customerName;
  const envelope: IntakeExtractionEnvelope = { v1: draft, v2: null, active: 'v1' };
  await supabase
    .from('intake_drafts')
    .update({ status: 'ready', ai_extraction: envelope, parsed_by: model_override })
    .eq('id', draftId);

  return { ok: true, draftId, draft, transcript: transcript || null, parsedBy: model_override };
}

export type AcceptInboundResult =
  | { ok: true; projectId: string }
  | { ok: false; error: string; duplicates?: ContactMatch[] };

export async function acceptInboundLeadAction(
  draft: ParsedIntake,
  options?: {
    /** Use this existing customer id instead of creating a new one. */
    useExistingContactId?: string;
    /** Skip the dedup check. Set after operator clicks "Create anyway". */
    confirmCreate?: boolean;
    /**
     * Persisted intake_drafts row id this acceptance is consuming. When
     * provided, the draft row gets `accepted_project_id` stamped on
     * success so we can correlate drafts to their resulting projects
     * for eval / quality work.
     */
    draftId?: string;
  },
): Promise<AcceptInboundResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const customerName = draft.customer.name?.trim();
  if (!customerName) return { ok: false, error: 'Customer name is required.' };

  // 1. Customer — resolve to an existing row, or check for duplicates before
  //    creating a new one.
  let customerId: string;
  if (options?.useExistingContactId) {
    customerId = options.useExistingContactId;
  } else {
    if (!options?.confirmCreate) {
      const duplicates = await findContactMatches({
        name: customerName,
        phone: draft.customer.phone,
        email: draft.customer.email,
      });
      if (duplicates.length > 0) {
        return {
          ok: false,
          error:
            duplicates.length === 1
              ? 'A contact like this already exists. Attach the project to them or create a new contact.'
              : 'Contacts like this already exist. Attach the project to one of them or create new.',
          duplicates,
        };
      }
    }

    const { data: cust, error: custErr } = await supabase
      .from('customers')
      .insert({
        tenant_id: tenant.id,
        kind: 'customer',
        type: 'residential',
        name: customerName,
        email: draft.customer.email?.trim() || null,
        phone: draft.customer.phone?.trim() || null,
        address_line1: draft.customer.address?.trim() || null,
      })
      .select('id')
      .single();
    if (custErr || !cust) {
      return { ok: false, error: custErr?.message ?? 'Failed to create customer.' };
    }
    customerId = cust.id;
  }
  const cust = { id: customerId };

  // 2. Project
  const projectName = draft.project.name?.trim() || `${customerName} project`;
  const { data: proj, error: projErr } = await supabase
    .from('projects')
    .insert({
      tenant_id: tenant.id,
      customer_id: cust.id,
      name: projectName,
      description: draft.project.description?.trim() || null,
      intake_source: 'text-thread',
      intake_signals: draft.signals,
    })
    .select('id')
    .single();
  if (projErr || !proj) {
    return { ok: false, error: projErr?.message ?? 'Failed to create project.' };
  }

  // 3. Budget categories
  const categoryRows = draft.categories.map((b, i) => ({
    project_id: proj.id,
    tenant_id: tenant.id,
    name: b.name,
    section: b.section?.trim() || 'General',
    display_order: i,
  }));
  let categoryIds: string[] = [];
  if (categoryRows.length) {
    const { data: bs, error: bErr } = await supabase
      .from('project_budget_categories')
      .insert(categoryRows)
      .select('id');
    if (bErr) return { ok: false, error: `Categories: ${bErr.message}` };
    categoryIds = (bs ?? []).map((b) => b.id);
  }

  // 4. Cost lines
  const lineRows: Array<Record<string, unknown>> = [];
  draft.categories.forEach((b, bi) => {
    const categoryId = categoryIds[bi] ?? null;
    b.lines.forEach((l, li) => {
      const qty = Number(l.qty) || 1;
      const unitPrice = Number(l.unit_price_cents ?? 0) || 0;
      lineRows.push({
        project_id: proj.id,
        budget_category_id: categoryId,
        category: 'material',
        label: l.label,
        notes: l.notes?.trim() || null,
        qty,
        unit: l.unit || 'lot',
        unit_cost_cents: 0,
        unit_price_cents: unitPrice,
        line_cost_cents: 0,
        line_price_cents: Math.round(qty * unitPrice),
        markup_pct: 0,
        sort_order: li,
      });
    });
  });
  if (lineRows.length) {
    const { error: lErr } = await supabase.from('project_cost_lines').insert(lineRows);
    if (lErr) return { ok: false, error: `Cost lines: ${lErr.message}` };
  }

  // 5. Worklog
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Project created from text thread',
    body: `Project "${projectName}" created via inbound intake.${
      draft.signals.competitive ? ' ⚠ Customer is shopping (competitive).' : ''
    }`,
    related_type: 'project',
    related_id: proj.id,
  });

  // Stamp the draft row so we can trace project → draft → transcript
  // for evals and quality work. Best-effort — don't fail acceptance
  // if the stamp fails (the project is created and shouldn't roll back
  // for a metadata write).
  if (options?.draftId) {
    await supabase
      .from('intake_drafts')
      .update({ accepted_project_id: proj.id })
      .eq('id', options.draftId);
  }

  revalidatePath('/projects');
  return { ok: true, projectId: proj.id };
}

/**
 * Audio transcription. We use OpenAI's `gpt-4o-transcribe` (same price as
 * the older `whisper-1` but materially better on proper nouns, addresses,
 * and noisy jobsite recordings — a lot of these memos are recorded with
 * compressors and saws running).
 *
 * The `prompt` parameter biases the model toward the vocabulary a GC is
 * likely to use, which improves recognition of construction terms +
 * proper-noun-like scope items.
 *
 * Returns the transcript text on success, null on any failure. The caller
 * folds the transcript into pastedText so the downstream vision/text
 * prompt sees it as if the operator had typed it.
 */
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const TRANSCRIBE_PROMPT =
  "General contractor scoping a residential renovation. The speaker is the contractor, not the customer; they mention the customer's first name, the job address (street number + street name), budget hints, and scope items such as flooring, baseboards, trim, demo, paint, drywall, tile, framing, plumbing, electrical, HVAC, insulation, cabinets, countertops, plywood, subfloor, transitions, stair nose, carpet removal, fixtures, finishes, kitchen, bathroom, basement, deck, fence, roof, siding, exterior.";

async function transcribeAudio(file: File, tenantId: string): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  const res = await gateway().runTranscribe({
    kind: 'transcribe',
    task: 'audio_transcribe_intake',
    tenant_id: tenantId,
    model_override: TRANSCRIBE_MODEL,
    file: { mime: file.type, base64: buf.toString('base64'), filename: file.name || undefined },
    prompt: TRANSCRIBE_PROMPT,
  });
  // Empty transcript is a real result (silent audio) — return as-is.
  // Errors propagate to the caller so the operator sees a real message
  // instead of an Opus hallucination about missing screenshots.
  return res.text.trim();
}
