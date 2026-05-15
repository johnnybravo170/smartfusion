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

import { randomUUID } from 'node:crypto';
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
import {
  loadIntakeCustomerContext,
  renderCustomerContextForPrompt,
} from '@/lib/db/queries/intake-customer-context';
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

/**
 * Per-artifact classification kinds. Drives the chip row at the top of
 * the review screen — the "Henry sees what you dropped" demo moment.
 * The label is a short Henry-generated description (max ~80 chars)
 * shown alongside the chip's kind.
 */
const ARTIFACT_KINDS = [
  'voice_memo',
  'damage_photo',
  'reference_photo',
  'sketch',
  'screenshot',
  'sub_quote_pdf',
  'spec_drawing_pdf',
  'receipt',
  'inspiration_photo',
  'customer_message',
  'text_body',
  'other',
] as const;
export type IntakeArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type IntakeArtifact = {
  path: string;
  name: string;
  mime: string;
  size: number;
  kind: IntakeArtifactKind | null;
  label: string | null;
};

/**
 * A scope-augmentation suggestion. Henry surfaces these after the
 * parse — common renovation items the operator may have missed
 * (transition strips, casing alongside baseboards, disposal lines, etc.).
 *
 * The operator accepts (line gets added to the editable draft) or
 * dismisses (suggestion drops off the list). Local-only state in the
 * UI for this slice; the persisted list is informational.
 */
export type IntakeAugmentation = {
  id: string;
  title: string;
  reasoning: string;
  suggested_category: string;
  suggested_section: 'interior' | 'exterior';
  confidence: 'high' | 'medium' | 'low';
};

const AUGMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          reasoning: { type: 'string' },
          suggested_category: { type: 'string' },
          suggested_section: { type: 'string', enum: ['interior', 'exterior'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'reasoning', 'suggested_category', 'suggested_section', 'confidence'],
      },
    },
  },
  required: ['suggestions'],
};

const AUGMENT_PROMPT = `You're a senior Canadian general contractor reviewing an intake estimate Henry just drafted from a homeowner conversation.

Your job: surface 0–5 line items that are LIKELY MISSING from the draft based on standard renovation patterns. These are the kinds of things contractors regularly forget to mention but always end up doing — and homeowners are surprised to be charged for if they aren't quoted up front.

Examples of what to look for:
- Transition strips / reducers wherever flooring meets a different surface, especially at doorways
- Door casing whenever baseboards are being replaced (same trim work, sourced together)
- Disposal / dump fees alongside any meaningful demo
- Patching + painting wherever drywall, framing, or electrical work cuts into walls
- Plumbing rough-in adjustments when fixtures move
- Final caulking + fill scope alongside any millwork install
- Permit fees for work that needs them (electrical, plumbing, structural)
- Plywood underlayment when running new flooring over existing subfloor with height changes
- Stair-edge mitered returns when flooring carries to a stair top

Rules:
1. Only suggest items where there's REAL evidence in the scope to back it (e.g. "baseboards in scope but no casing" → suggest casing). Don't guess at things the scope doesn't imply.
2. Each suggestion needs a CONCRETE reasoning sentence pointing to what in the draft made you think it's missing.
3. If the scope already covers the item (even loosely), do NOT suggest it. Read the existing categories + lines carefully first.
4. Match suggested_category to one of the EXISTING category names in the draft when possible. Only invent a new category name when nothing existing fits.
5. Confidence:
   - high: contractor would always add this if doing the rest of the scope
   - medium: usually included, depends on specifics
   - low: worth a heads-up, but easy to skip
6. Empty list is fine — better than padding suggestions just to fill the array.

Title is short (max ~50 chars). Reasoning is one sentence. Return JSON via the schema.`;

const ARTIFACT_CLASSIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
          label: { type: 'string' },
        },
        required: ['index', 'kind', 'label'],
      },
    },
  },
  required: ['artifacts'],
};

const ARTIFACT_CLASSIFY_PROMPT = `You're inspecting artifacts the operator dropped into a renovation project intake. For each artifact (in order, 0-indexed) classify it into ONE of these kinds:

- voice_memo (audio recording — usually a contractor scoping a job)
- damage_photo (photo showing damage, defects, or conditions to repair)
- reference_photo (photo of an existing condition / area / fixture for context, not damage-focused)
- sketch (hand-drawn site plan, layout, or quick diagram)
- screenshot (text-thread, email, or messaging-app capture)
- sub_quote_pdf (PDF quote from a sub-trade)
- spec_drawing_pdf (architectural drawing, floor plan, or technical spec PDF)
- receipt (invoice or receipt for materials / supplies — includes screenshots of receipts, not just PDFs)
- inspiration_photo (Pinterest-style aesthetic shot — what the customer wants it to look like)
- customer_message (email or text FROM a customer that the operator is forwarding — scope question, complaint, change request, etc.)
- text_body (the body of a forwarded email itself, as text — never from an attachment, only from the email envelope)
- other (when nothing fits)

Also produce a short label (max 80 chars) describing what's IN the artifact specifically. Examples: "Water-damaged hardwood near the back door", "Text thread — kitchen reno scope", "Sub-trade quote — electrical, 4 lines".

CONTEXT HINTS (especially when artifacts arrive via forwarded email):
- The email subject and the leading paragraph of the body are USUALLY the operator's intent hint — "Fwd: Receipt for Glenwood" strongly suggests the attachment is a receipt for the Glenwood project. Treat as a possible-intent signal, not a directive: if the subject says "receipt" but the attachment is clearly a permit, classify as spec_drawing_pdf and note the discrepancy in the label.
- A text_body artifact is the email's text content. It informs the OTHER artifacts' classification but is itself classified as text_body.
- Screenshots-of-receipts: the artifact is visually a screenshot (PNG/JPG), but its CONTENT is a receipt — classify as receipt, not screenshot. Same logic for screenshots of permits (spec_drawing_pdf), text threads from customers (customer_message if the customer is the speaker), etc. Classify by what it IS, not by how it was captured.

Return one row per artifact. The "index" must match the artifact's position in the order they were attached.`;

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
  // Tracks each downloaded artifact in upload order. Used both for the
  // chip-row classification (visuals + audios indexed) and to write the
  // artifacts column on the draft row so the chip row is recoverable
  // across refresh / retry.
  const allArtifacts: IntakeArtifact[] = [];
  const visualFilesForClassify: Array<{ index: number; file: File }> = [];
  const audioIndexesForClassify: number[] = [];
  let artifactIdx = 0;
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
      const thisIndex = artifactIdx++;
      allArtifacts.push({
        path,
        name: originalName,
        mime: type,
        size: blob.size,
        kind: null,
        label: null,
      });
      if (type.startsWith('audio/')) {
        audioIndexesForClassify.push(thisIndex);
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
        visualFilesForClassify.push({ index: thisIndex, file: f });
      }
      // Artifacts persist in `intake-audio` storage until the project
      // is accepted — `acceptInboundLeadAction` sweeps them at that
      // point. Keeping them around enables thumbnail previews on the
      // chip row, future "iterate on draft" with original visuals,
      // and post-failure manual diagnosis. The oversize-reject and
      // transcribe-failure paths above still delete (rejected files
      // shouldn't linger; failed Whisper means the audio was
      // unprocessable).
    }
  }
  const transcript = transcriptParts.length > 0 ? transcriptParts.join('\n\n---\n\n') : null;

  // Customer-context fold-in. If the operator typed a name that matches
  // an existing customer, hydrate their last few projects' shape and
  // inject as prompt context so the parse skews toward known patterns
  // and the reply reads as a continuation, not a stranger intro.
  // Persist recognized_customer_id on the row for the UI's recognition
  // pill + future eval correlation.
  const customerContext = customerName ? await loadIntakeCustomerContext(customerName) : null;
  const customerContextBlock = renderCustomerContextForPrompt(customerContext);

  await updateDraft({
    status: 'extracting',
    transcript,
    artifacts: allArtifacts,
    recognized_customer_id: customerContext?.customerId ?? null,
  });

  // Build the prompt + the typed file list.
  const intro = [
    `Tenant: ${tenant.name ?? 'Contractor'}`,
    `Customer (operator-supplied): ${customerName || '(not provided)'}`,
    customerContextBlock ?? '',
    pastedText
      ? `Pasted message text:\n${pastedText}`
      : '(No pasted text — extract everything from the screenshots.)',
    files.length
      ? `${files.length} artifact(s) follow (images and/or PDFs), indexed 0..${files.length - 1}.`
      : '(No artifacts.)',
  ]
    .filter(Boolean)
    .join('\n\n');

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

  // Run the heavy parse in parallel with the per-artifact classification
  // call. Classification is best-effort (its helper catches its own
  // errors) so this Promise.all only rejects on parse error.
  const parsePromise = gateway().runStructured<ParsedIntake>({
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
  const classifyPromise = classifyArtifacts(
    visualFilesForClassify,
    audioIndexesForClassify,
    allArtifacts.length,
    tenant.id,
  );

  let draft: ParsedIntake;
  let classifications: Awaited<ReturnType<typeof classifyArtifacts>> = [];
  try {
    const [parseRes, classifyRes] = await Promise.all([parsePromise, classifyPromise]);
    draft = parseRes.data;
    classifications = classifyRes;
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

  // Merge classifications into the artifact rows.
  const finalArtifacts: IntakeArtifact[] = allArtifacts.map((a, i) => {
    const c = classifications.find((row) => row.index === i);
    return c ? { ...a, kind: c.kind, label: c.label } : a;
  });

  // Post-parse scope augmentation. Runs sequentially because it depends
  // on the parsed extraction. Best-effort — empty list on failure.
  // ~3-5 s typical; well within the 120 s page budget after a parse.
  const augmentations = await augmentScope(draft, transcript, tenant.id);

  // Persist the extraction in the same envelope shape used by
  // project_memos (migration 0174). Lets the second-pass / thinking
  // button drop in unchanged when we wire it for intake.
  const envelope: IntakeExtractionEnvelope = { v1: draft, v2: null, active: 'v1' };
  await updateDraft({
    status: 'ready',
    ai_extraction: envelope,
    parsed_by: model_override,
    artifacts: finalArtifacts,
    augmentations,
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
  // Load the draft via the admin client because this action is invoked
  // from BOTH UI contexts (operator clicked "reparse" on /inbox/intake —
  // has a session cookie) and service-role contexts (Postmark inbound
  // webhook, /api/widget/submit — public-token-authenticated, no
  // session). The RLS-scoped client returns no row in the service path,
  // which silently breaks classification of every email- and form-sourced
  // lead. Tenant authz is enforced explicitly below for session callers.
  const admin = createAdminClient();
  const { data: row, error: loadErr } = await admin
    .from('intake_drafts')
    .select('id, tenant_id, status, customer_name, pasted_text, transcript, ai_extraction')
    .eq('id', draftId)
    .maybeSingle();
  if (loadErr || !row) return { ok: false, error: 'Draft not found.' };

  const draftTenantId = row.tenant_id as string;
  const sessionTenant = await getCurrentTenant();
  if (sessionTenant && sessionTenant.id !== draftTenantId) {
    // A logged-in user trying to operate on a draft from a different
    // tenant. RLS would have hidden the row before this refactor; the
    // explicit check preserves that boundary.
    return { ok: false, error: 'Not authorized for this draft.' };
  }

  // Resolve the tenant name for the prompt. Session caller already has
  // it; service caller looks it up.
  let tenantName: string | null;
  if (sessionTenant) {
    tenantName = sessionTenant.name;
  } else {
    const { data: t } = await admin
      .from('tenants')
      .select('name')
      .eq('id', draftTenantId)
      .maybeSingle();
    if (!t) return { ok: false, error: 'Tenant not found.' };
    tenantName = (t.name as string | null) ?? null;
  }
  const tenant = { id: draftTenantId, name: tenantName };

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

  // Customer recognition uses the RLS-scoped client (it's the operator's
  // address book). In the service path there's no session, so this
  // degrades to `null` — emails / widget submits won't auto-recognize a
  // returning customer on first parse. Operators can still reparse from
  // the inbox to pick that up. Acceptable trade for V1.
  const customerContext =
    sessionTenant && customerName ? await loadIntakeCustomerContext(customerName) : null;
  const customerContextBlock = renderCustomerContextForPrompt(customerContext);

  await admin
    .from('intake_drafts')
    .update({
      status: 'extracting',
      error_message: null,
      recognized_customer_id: customerContext?.customerId ?? null,
    })
    .eq('id', draftId);

  const transcriptBlock = transcript ? `Voice memo transcript:\n${transcript}` : '';
  const pastedBlock = pasted ? `Pasted message text:\n${pasted}` : '';
  const intro = [
    `Tenant: ${tenant.name ?? 'Contractor'}`,
    `Customer (operator-supplied): ${customerName || '(not provided)'}`,
    customerContextBlock ?? '',
    [transcriptBlock, pastedBlock].filter(Boolean).join('\n\n') ||
      '(No transcript or pasted text — degraded retry.)',
    '(No artifacts on retry — photos/PDFs from the original upload were not persisted.)',
  ]
    .filter(Boolean)
    .join('\n\n');

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
    await admin
      .from('intake_drafts')
      .update({ status: 'failed', error_message: message })
      .eq('id', draftId);
    return { ok: false, error: message, draftId };
  }

  if (customerName) draft.customer.name = customerName;
  const envelope: IntakeExtractionEnvelope = { v1: draft, v2: null, active: 'v1' };
  // Re-run augmentation against the fresh parse — best-effort, empty
  // on failure. The previous augmentations are stale once the parse
  // changes, so overwrite rather than merge.
  const augmentations = await augmentScope(draft, transcript || null, tenant.id);
  await admin
    .from('intake_drafts')
    .update({
      status: 'ready',
      ai_extraction: envelope,
      parsed_by: model_override,
      augmentations,
    })
    .eq('id', draftId);

  return { ok: true, draftId, draft, transcript: transcript || null, parsedBy: model_override };
}

export type AppendInboundResult =
  | { ok: true; draftId: string; addedSuggestionCount: number; addedArtifactCount: number }
  | { ok: false; error: string; draftId?: string };

/**
 * Iterate-on-draft. The operator already has a ready draft on the
 * review screen and drops MORE stuff in (another voice memo, a photo,
 * pasted text, a sub-trade quote PDF). Henry takes the new inputs +
 * the existing draft and surfaces additional suggestions for the
 * operator to accept or dismiss.
 *
 * Behavior:
 *   - Whisper any new audio → append to the row's transcript.
 *   - Classify any new visual artifacts → append to the row's
 *     artifacts column (chip row updates).
 *   - Re-run augmentScope against the cumulative transcript +
 *     existing draft; dedupe new suggestions against the existing
 *     augmentations (case-insensitive title match) and append the
 *     fresh ones.
 *   - Operator's edits to the draft are NOT overwritten — the parsed
 *     extraction (envelope.v1) is unchanged. Only suggestions and
 *     artifacts grow.
 *
 * Returns counts of what was added so the UI can toast a useful
 * message ("Henry added 2 more suggestions, classified 1 photo").
 */
export async function appendToIntakeDraftAction(
  draftId: string,
  formData: FormData,
): Promise<AppendInboundResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: row, error: loadErr } = await supabase
    .from('intake_drafts')
    .select(
      'id, status, transcript, pasted_text, artifacts, augmentations, ai_extraction, customer_name',
    )
    .eq('id', draftId)
    .maybeSingle();
  if (loadErr || !row) return { ok: false, error: 'Draft not found.' };
  if (row.status !== 'ready' && row.status !== 'failed') {
    return {
      ok: false,
      error: `Can't append while Henry is still working (status: ${row.status as string}).`,
      draftId,
    };
  }

  const newPastedText = String(formData.get('pastedText') ?? '').trim();
  const newStorageEntries: Array<{ path: string; name: string }> = [];
  for (const entry of formData.getAll('storageEntries')) {
    if (typeof entry !== 'string') continue;
    try {
      const parsed = JSON.parse(entry) as { path?: unknown; name?: unknown };
      if (typeof parsed.path === 'string' && parsed.path.length > 0) {
        newStorageEntries.push({
          path: parsed.path,
          name: typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : 'file',
        });
      }
    } catch {
      // Skip malformed
    }
  }

  if (!newPastedText && newStorageEntries.length === 0) {
    return { ok: false, error: 'Nothing to add — drop a file or paste some text.', draftId };
  }
  if (newStorageEntries.length > MAX_IMAGES) {
    return { ok: false, error: `Too many files (max ${MAX_IMAGES}).`, draftId };
  }

  const existingArtifacts = (row.artifacts as IntakeArtifact[] | null) ?? [];
  const existingAugmentations = (row.augmentations as IntakeAugmentation[] | null) ?? [];
  const existingTranscript = (row.transcript as string | null) ?? '';
  const baseIndex = existingArtifacts.length;
  const envelope = row.ai_extraction as {
    v1: ParsedIntake | null;
    v2: ParsedIntake | null;
    active: 'v1' | 'v2';
  } | null;
  const existingDraft = envelope?.[envelope.active] ?? envelope?.v1 ?? null;

  await supabase
    .from('intake_drafts')
    .update({ status: 'extracting', error_message: null })
    .eq('id', draftId);

  const newTranscriptParts: string[] = [];
  const newArtifacts: IntakeArtifact[] = [];
  const newVisualFilesForClassify: Array<{ index: number; file: File }> = [];
  const newAudioIndexesForClassify: number[] = [];
  let cursorIndex = baseIndex;

  if (newStorageEntries.length > 0) {
    const admin = createAdminClient();
    for (const { path, name: originalName } of newStorageEntries) {
      const { data: blob, error: dlErr } = await admin.storage.from('intake-audio').download(path);
      if (dlErr || !blob) continue;
      if (blob.size > MAX_BYTES) {
        await admin.storage.from('intake-audio').remove([path]);
        await supabase
          .from('intake_drafts')
          .update({ status: 'ready', error_message: 'A staged file was larger than 25MB.' })
          .eq('id', draftId);
        return { ok: false, error: `A staged file is larger than 25MB.`, draftId };
      }
      const type = blob.type || 'application/octet-stream';
      const f = new File([blob], originalName, { type });
      const thisIndex = cursorIndex++;
      newArtifacts.push({
        path,
        name: originalName,
        mime: type,
        size: blob.size,
        kind: null,
        label: null,
      });
      if (type.startsWith('audio/')) {
        newAudioIndexesForClassify.push(thisIndex);
        try {
          const t = await transcribeAudio(f, tenant.id);
          if (t) {
            newTranscriptParts.push(`Voice memo (file: "${originalName}"):\n${t}`);
          }
        } catch (err) {
          Sentry.captureException(err, {
            tags: { stage: 'intake.append.transcribe', task: 'audio_transcribe_intake' },
            extra: { filename: originalName, draftId },
          });
          // Keep going — the operator's other inputs may still produce
          // useful suggestions. Surface a soft warning at the end.
        }
      } else if (type.startsWith('image/') || type === 'application/pdf') {
        newVisualFilesForClassify.push({ index: thisIndex, file: f });
      }
      // Same as the main parse loop — artifacts persist until accept.
      // The oversize-reject path above still deletes.
    }
  }

  const newClassifications = await classifyArtifacts(
    newVisualFilesForClassify,
    newAudioIndexesForClassify,
    cursorIndex,
    tenant.id,
  );
  const classifiedNewArtifacts: IntakeArtifact[] = newArtifacts.map((a, i) => {
    const globalIdx = baseIndex + i;
    const c = newClassifications.find((row) => row.index === globalIdx);
    return c ? { ...a, kind: c.kind, label: c.label } : a;
  });

  const fullTranscriptParts: string[] = [];
  if (existingTranscript) fullTranscriptParts.push(existingTranscript);
  if (newTranscriptParts.length > 0)
    fullTranscriptParts.push(newTranscriptParts.join('\n\n---\n\n'));
  if (newPastedText) fullTranscriptParts.push(`Operator added (pasted):\n${newPastedText}`);
  const fullTranscript = fullTranscriptParts.join('\n\n=== APPENDED ===\n\n');

  // Run augmentation against the cumulative state. Best-effort.
  let freshSuggestions: IntakeAugmentation[] = [];
  if (existingDraft) {
    freshSuggestions = await augmentScope(existingDraft, fullTranscript, tenant.id);
  }

  // Dedupe new suggestions against existing ones (case-insensitive
  // title match). Operator's existing dismissals stay valid because
  // dismissed ids are preserved client-side.
  const existingTitles = new Set(
    existingAugmentations.map((s) => (s.title ?? '').trim().toLowerCase()),
  );
  const dedupedFresh = freshSuggestions.filter(
    (s) => !existingTitles.has((s.title ?? '').trim().toLowerCase()),
  );

  const mergedAugmentations = [...existingAugmentations, ...dedupedFresh];
  const mergedArtifacts = [...existingArtifacts, ...classifiedNewArtifacts];
  const mergedPasted = newPastedText
    ? `${(row.pasted_text as string | null) ?? ''}${row.pasted_text ? '\n\n' : ''}${newPastedText}`
    : ((row.pasted_text as string | null) ?? null);
  const mergedTranscriptStored =
    newTranscriptParts.length > 0
      ? [existingTranscript, newTranscriptParts.join('\n\n---\n\n')]
          .filter(Boolean)
          .join('\n\n=== APPENDED ===\n\n')
      : existingTranscript || null;

  await supabase
    .from('intake_drafts')
    .update({
      status: 'ready',
      artifacts: mergedArtifacts,
      augmentations: mergedAugmentations,
      transcript: mergedTranscriptStored,
      pasted_text: mergedPasted,
    })
    .eq('id', draftId);

  revalidatePath(`/projects/new?draft=${draftId}`);
  return {
    ok: true,
    draftId,
    addedSuggestionCount: dedupedFresh.length,
    addedArtifactCount: classifiedNewArtifacts.length,
  };
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
  // for evals and quality work, then sweep the artifact files we kept
  // around in storage during the draft's lifetime. Best-effort —
  // don't fail acceptance if the stamp/sweep fails (the project is
  // created and shouldn't roll back for a storage hiccup).
  if (options?.draftId) {
    const { data: draftRow } = await supabase
      .from('intake_drafts')
      .select('artifacts')
      .eq('id', options.draftId)
      .maybeSingle();
    const paths = ((draftRow?.artifacts as IntakeArtifact[] | null) ?? [])
      .map((a) => a.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (paths.length > 0) {
      const admin = createAdminClient();
      await admin.storage
        .from('intake-audio')
        .remove(paths)
        .catch(() => {
          // Best-effort. The accepted_project_id stamp tells us which
          // draft consumed the project; a future cleanup script can
          // sweep any orphaned paths from accepted drafts.
        });
    }
    await supabase
      .from('intake_drafts')
      .update({ accepted_project_id: proj.id, artifacts: [] })
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

/**
 * Per-artifact classification — the "Henry sees what you dropped" demo
 * moment. Audio is shortcutted locally as 'voice_memo' (no model call).
 * Images + PDFs go to Gemini Flash in one batched structured call.
 *
 * Best-effort: a failure returns mime-derived defaults so the chip row
 * still renders something useful; never blocks the rest of the
 * pipeline.
 */
async function classifyArtifacts(
  visualFiles: Array<{ index: number; file: File }>,
  audioIndexes: number[],
  totalCount: number,
  tenantId: string,
): Promise<Array<{ index: number; kind: IntakeArtifactKind; label: string }>> {
  const results: Array<{ index: number; kind: IntakeArtifactKind; label: string }> = [];

  // Audio: classified locally. We trust the upload mime / extension —
  // burning a Gemini call to confirm "yes that's audio" is wasted spend.
  for (const idx of audioIndexes) {
    results.push({ index: idx, kind: 'voice_memo', label: 'Voice memo' });
  }

  if (visualFiles.length === 0) {
    return sortByIndex(results, totalCount);
  }

  try {
    const attached: AttachedFile[] = [];
    for (const { file } of visualFiles) {
      const buf = Buffer.from(await file.arrayBuffer());
      attached.push({
        mime: file.type || 'application/octet-stream',
        base64: buf.toString('base64'),
        filename: file.name || undefined,
      });
    }

    const indexMap = visualFiles.map(({ index }) => index);
    const indexHint = indexMap
      .map((globalIdx, localIdx) => `Position ${localIdx} → artifact #${globalIdx}`)
      .join('\n');

    type ClassifyResponse = {
      artifacts: Array<{ index: number; kind: IntakeArtifactKind; label: string }>;
    };
    const res = await gateway().runStructured<ClassifyResponse>({
      kind: 'structured',
      task: 'intake_artifact_classify',
      tenant_id: tenantId,
      prompt: `${ARTIFACT_CLASSIFY_PROMPT}\n\nIndex mapping (use these "index" values in your response):\n${indexHint}`,
      schema: ARTIFACT_CLASSIFY_SCHEMA,
      files: attached,
      temperature: 0,
      max_tokens: 1500,
    });

    const valid = new Set<IntakeArtifactKind>(ARTIFACT_KINDS);
    for (const row of res.data.artifacts ?? []) {
      const kind = valid.has(row.kind) ? row.kind : 'other';
      const label =
        (row.label ?? '').trim().slice(0, 200) || mimeDefaultLabel(visualFiles, row.index);
      results.push({ index: row.index, kind, label });
    }
  } catch {
    // Fall back to mime-derived defaults so the chip row still renders.
    for (const { index, file } of visualFiles) {
      results.push({
        index,
        kind: file.type === 'application/pdf' ? 'other' : 'reference_photo',
        label: file.name || 'Artifact',
      });
    }
  }

  // Backfill any indexes the model omitted.
  const seen = new Set(results.map((r) => r.index));
  for (const { index, file } of visualFiles) {
    if (seen.has(index)) continue;
    results.push({
      index,
      kind: file.type === 'application/pdf' ? 'other' : 'reference_photo',
      label: file.name || 'Artifact',
    });
  }

  return sortByIndex(results, totalCount);
}

function sortByIndex<T extends { index: number }>(rows: T[], totalCount: number): T[] {
  return [...rows]
    .sort((a, b) => a.index - b.index)
    .filter((r) => r.index >= 0 && r.index < totalCount);
}

function mimeDefaultLabel(
  visualFiles: Array<{ index: number; file: File }>,
  index: number,
): string {
  const match = visualFiles.find((v) => v.index === index);
  return match?.file.name || 'Artifact';
}

/**
 * Post-parse scope augmentation. Looks at the parsed extraction +
 * transcript and suggests items the operator may have missed based on
 * standard renovation patterns. Best-effort: failures return an empty
 * list rather than blocking the parse.
 */
async function augmentScope(
  parsed: ParsedIntake,
  transcript: string | null,
  tenantId: string,
): Promise<IntakeAugmentation[]> {
  try {
    const scopeSummary = parsed.categories
      .map((c) => {
        const lines = c.lines.map((l) => `    - ${l.label}${l.notes ? ` (${l.notes})` : ''}`);
        return `  ${c.section ?? 'General'} / ${c.name}:\n${lines.join('\n')}`;
      })
      .join('\n\n');

    const intro = [
      'PARSED DRAFT (current categories + lines):',
      scopeSummary || '  (no categories yet)',
      '',
      transcript ? `TRANSCRIPT (for context):\n${transcript}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    type AugmentResponse = {
      suggestions: Array<Omit<IntakeAugmentation, 'id'>>;
    };
    const res = await gateway().runStructured<AugmentResponse>({
      kind: 'structured',
      task: 'intake_scope_augment',
      tenant_id: tenantId,
      prompt: `${AUGMENT_PROMPT}\n\n${intro}`,
      schema: AUGMENT_SCHEMA,
      temperature: 0.1,
      max_tokens: 1500,
    });
    return (res.data.suggestions ?? []).slice(0, 5).map((s) => ({
      id: randomUUID(),
      title: (s.title ?? '').slice(0, 120),
      reasoning: (s.reasoning ?? '').slice(0, 400),
      suggested_category: s.suggested_category ?? 'General',
      suggested_section: s.suggested_section ?? 'interior',
      confidence: s.confidence ?? 'medium',
    }));
  } catch {
    return [];
  }
}
