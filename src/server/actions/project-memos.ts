'use server';

/**
 * Server actions for voice memo upload, transcription, and extraction.
 *
 * Two-stage pipeline (split Apr 2026 — was a unified Gemini call before):
 *   Stage 1 — audio → transcript. Gemini Flash, plain vision call, text out.
 *   Stage 2 — transcript + photos → structured work items. Opus 4.7,
 *             tool-use structured output. Optional extended thinking on
 *             a user-triggered second pass.
 *
 * `ai_extraction` is a versioned envelope so v1 (first pass) and v2 (second
 * pass with thinking) can sit side by side and the UI can flip between
 * them. See migration 0174.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { type AttachedFile, gateway } from '@/lib/ai-gateway';
import { getCurrentTenant } from '@/lib/auth/helpers';
import {
  deleteFromStorage as deletePhotoFromStorage,
  uploadToStorage as uploadPhotoToStorage,
} from '@/lib/storage/photos';
import { createClient } from '@/lib/supabase/server';

export type MemoActionResult = { ok: true; id: string } | { ok: false; error: string };
export type MemoDeleteResult = { ok: true } | { ok: false; error: string };

export type MemoExtraction = {
  work_items: {
    area: string;
    description: string;
    suggested_category: string;
    section: string;
    referenced_photo_indexes?: number[];
  }[];
  customer_preferences: string[];
  uncertainty_flags: string[];
};

export type MemoExtractionEnvelope = {
  v1: MemoExtraction | null;
  v2: MemoExtraction | null;
  active: 'v1' | 'v2';
};

export type MemoVersion = 'v1' | 'v2';

const PHOTO_EXT_MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
};

function photoExtFromFile(file: File): string {
  const name = file.name ?? '';
  const dot = name.lastIndexOf('.');
  if (dot > -1 && dot < name.length - 1) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
  }
  const mime = (file.type || '').toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

/**
 * Upload audio to Supabase Storage and create a memo row with status=pending.
 */
export async function uploadMemoAction(formData: FormData): Promise<MemoActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const projectId = formData.get('project_id') as string;
  const audioFile = formData.get('audio') as File;

  if (!projectId) return { ok: false, error: 'Missing project_id.' };
  if (!audioFile || audioFile.size === 0) return { ok: false, error: 'No audio file provided.' };

  const supabase = await createClient();

  // Create the memo row first to get the ID for the storage path
  const { data: memo, error: memoErr } = await supabase
    .from('project_memos')
    .insert({
      project_id: projectId,
      tenant_id: tenant.id,
      status: 'pending',
    })
    .select('id')
    .single();

  if (memoErr || !memo) {
    return { ok: false, error: memoErr?.message ?? 'Failed to create memo.' };
  }

  // Upload to storage
  const ext = audioFile.name.split('.').pop() || 'webm';
  const storagePath = `${tenant.id}/${projectId}/${memo.id}.${ext}`;
  const arrayBuffer = await audioFile.arrayBuffer();

  const { error: uploadErr } = await supabase.storage
    .from('project-memos')
    .upload(storagePath, arrayBuffer, {
      contentType: audioFile.type || 'audio/webm',
      upsert: false,
    });

  if (uploadErr) {
    // Clean up the memo row
    await supabase.from('project_memos').delete().eq('id', memo.id);
    return { ok: false, error: `Upload failed: ${uploadErr.message}` };
  }

  // Update memo with audio URL
  const { data: urlData } = supabase.storage.from('project-memos').getPublicUrl(storagePath);

  await supabase.from('project_memos').update({ audio_url: urlData.publicUrl }).eq('id', memo.id);

  // Attach any photos bundled with the memo. Photos go into the `photos`
  // table/bucket (not the project-memos bucket) so the project's Gallery
  // tab sees them too. memo_id links them back to this memo.
  const photoFiles = formData
    .getAll('photo')
    .filter((v): v is File => v instanceof File && v.size > 0);
  for (const photoFile of photoFiles) {
    const photoId = randomUUID();
    const ext = photoExtFromFile(photoFile);
    const uploadRes = await uploadPhotoToStorage({
      tenantId: tenant.id,
      projectId,
      photoId,
      file: photoFile,
      contentType: photoFile.type || PHOTO_EXT_MIME_MAP[ext] || 'image/jpeg',
      extension: ext,
    });
    if ('error' in uploadRes) {
      // Skip this photo but don't tear down the memo — audio already landed.
      console.error('Memo photo upload failed:', uploadRes.error);
      continue;
    }
    const { error: photoInsertErr } = await supabase.from('photos').insert({
      id: photoId,
      tenant_id: tenant.id,
      project_id: projectId,
      memo_id: memo.id,
      storage_path: uploadRes.path,
      tag: 'other',
      mime: photoFile.type || PHOTO_EXT_MIME_MAP[ext] || 'image/jpeg',
      bytes: photoFile.size,
    });
    if (photoInsertErr) {
      await deletePhotoFromStorage(uploadRes.path).catch(() => {});
      console.error('Memo photo row insert failed:', photoInsertErr.message);
    }
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: memo.id };
}

const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    work_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string' },
          description: { type: 'string' },
          suggested_category: { type: 'string' },
          section: { type: 'string', enum: ['interior', 'exterior'] },
          referenced_photo_indexes: { type: 'array', items: { type: 'integer' } },
        },
        required: ['area', 'description', 'suggested_category', 'section'],
      },
    },
    customer_preferences: { type: 'array', items: { type: 'string' } },
    uncertainty_flags: { type: 'array', items: { type: 'string' } },
  },
  required: ['work_items', 'customer_preferences', 'uncertainty_flags'],
};

function buildExtractionPrompt(transcript: string, photoCount: number): string {
  const photoInstruction =
    photoCount > 0
      ? `\n\n${photoCount} site-walk ${photoCount === 1 ? 'photo is' : 'photos are'} attached after this prompt (in order, 0-indexed). For each work item, set "referenced_photo_indexes" to the indexes of photos that show the area or condition you're describing. Empty array if none are relevant.`
      : '';

  return `You are a renovation project assistant. The walkthrough below was just transcribed from audio recorded on-site. Extract concrete work items from the transcript and map each to a standard renovation budget category. Use the photos to ground area names and confirm conditions when relevant.

Standard interior categories: Demo, Disposal, Framing, Plumbing, Plumbing Fixtures, HVAC, Insulation, Drywall, Flooring, Doors & Mouldings, Windows & Doors, Railings, Electrical, Painting, Kitchen, Contingency.

Standard exterior categories: Demo, Disposal, Framing, Siding, Sheathing, Painting, Gutters, Front Garden, Front Door, Rot Repair, Garage Doors, Contingency.${photoInstruction}

--- TRANSCRIPT ---
${transcript}
--- END TRANSCRIPT ---

Return work_items, customer_preferences, and uncertainty_flags via the submit_response tool.`;
}

async function loadMemoPhotoFiles(
  supabase: Awaited<ReturnType<typeof createClient>>,
  memoId: string,
): Promise<AttachedFile[]> {
  const { data: memoPhotos } = await supabase
    .from('photos')
    .select('id, storage_path, mime')
    .eq('memo_id', memoId)
    .order('created_at', { ascending: true });

  const out: AttachedFile[] = [];
  for (const p of memoPhotos ?? []) {
    const path = p.storage_path as string;
    const { data: photoData } = await supabase.storage.from('photos').download(path);
    if (!photoData) continue;
    const photoBuf = await photoData.arrayBuffer();
    out.push({
      mime: (p.mime as string) || 'image/jpeg',
      base64: Buffer.from(photoBuf).toString('base64'),
    });
  }
  return out;
}

/**
 * Stage 1 + Stage 2 of the memo pipeline, chained.
 *
 * Stage 1 — Gemini transcribes the audio. Plain vision call, text only.
 * Stage 2 — Opus 4.7 turns the transcript (+ photos) into structured
 *           work items. No audio in this call — the transcript is the
 *           input. Result is stored as `ai_extraction.v1` with
 *           `active = 'v1'`.
 *
 * Triggered automatically by `uploadMemoAction` and re-runnable via the
 * "Retry" button if the first attempt fails.
 */
export async function transcribeMemoAction(memoId: string): Promise<MemoActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const { data: memo, error: loadErr } = await supabase
    .from('project_memos')
    .select('id, project_id, audio_url, status')
    .eq('id', memoId)
    .maybeSingle();

  if (loadErr || !memo) return { ok: false, error: 'Memo not found.' };
  if (!memo.audio_url) return { ok: false, error: 'No audio file attached to this memo.' };

  await supabase.from('project_memos').update({ status: 'transcribing' }).eq('id', memoId);

  try {
    const audioUrl = memo.audio_url as string;
    const storagePath = audioUrl.split('/project-memos/')[1];
    if (!storagePath) throw new Error('Invalid audio URL format.');

    const { data: fileData, error: downloadErr } = await supabase.storage
      .from('project-memos')
      .download(storagePath);
    if (downloadErr || !fileData) {
      throw new Error(`Failed to download audio: ${downloadErr?.message}`);
    }

    const audioBuffer = await fileData.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');

    const ext = storagePath.split('.').pop()?.toLowerCase();
    const mediaTypeMap: Record<string, string> = {
      webm: 'audio/webm',
      mp3: 'audio/mp3',
      mp4: 'audio/mp4',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      aac: 'audio/aac',
      flac: 'audio/flac',
    };
    const mediaType = mediaTypeMap[ext ?? 'webm'] ?? 'audio/webm';
    const audioFile: AttachedFile = { mime: mediaType, base64: base64Audio };

    // Stage 1 — transcribe.
    const transcribeRes = await gateway().runVision({
      kind: 'vision',
      task: 'project_memo_transcribe',
      tenant_id: tenant.id,
      prompt:
        'Transcribe this renovation site walkthrough audio. Return only the transcript text — no preamble, no commentary, no JSON. Preserve filler words and false starts only when they carry meaning; otherwise produce a clean, readable transcript.',
      file: audioFile,
    });
    const transcript = (transcribeRes.text ?? '').trim();
    if (!transcript) throw new Error('Transcription returned empty text.');

    await supabase
      .from('project_memos')
      .update({ transcript, status: 'extracting' })
      .eq('id', memoId);

    // Stage 2 — extract work items from transcript + photos with Opus 4.7.
    const photoFiles = await loadMemoPhotoFiles(supabase, memoId);
    const extractRes = await gateway().runStructured<MemoExtraction>({
      kind: 'structured',
      task: 'project_memo_extract',
      tenant_id: tenant.id,
      model_override: 'claude-opus-4-7',
      prompt: buildExtractionPrompt(transcript, photoFiles.length),
      schema: EXTRACTION_SCHEMA,
      files: photoFiles,
      temperature: 0,
    });

    const envelope: MemoExtractionEnvelope = {
      v1: extractRes.data,
      v2: null,
      active: 'v1',
    };

    await supabase
      .from('project_memos')
      .update({
        ai_extraction: envelope as unknown as Record<string, unknown>,
        status: 'ready',
      })
      .eq('id', memoId);

    revalidatePath(`/projects/${memo.project_id}`);
    return { ok: true, id: memoId };
  } catch (err) {
    await supabase.from('project_memos').update({ status: 'failed' }).eq('id', memoId);
    return {
      ok: false,
      error: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * User-triggered second pass — re-runs Stage 2 with extended thinking.
 * Result lands in `ai_extraction.v2` and `active` flips to `v2` so the
 * user sees the new attempt by default; they can flip back to v1 via
 * `setActiveMemoVersionAction` if they prefer the original.
 *
 * Requires v1 to already exist (i.e. a prior successful run). The
 * transcript is read from the memo row, so no audio handling here.
 */
export async function reExtractMemoAction(memoId: string): Promise<MemoActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const { data: memo, error: loadErr } = await supabase
    .from('project_memos')
    .select('id, project_id, transcript, ai_extraction')
    .eq('id', memoId)
    .maybeSingle();

  if (loadErr || !memo) return { ok: false, error: 'Memo not found.' };
  const transcript = (memo.transcript as string | null)?.trim() ?? '';
  if (!transcript) {
    return { ok: false, error: 'No transcript yet — run the first pass first.' };
  }
  const existing = (memo.ai_extraction as Record<string, unknown> | null) ?? null;

  await supabase.from('project_memos').update({ status: 'rethinking' }).eq('id', memoId);

  try {
    const photoFiles = await loadMemoPhotoFiles(supabase, memoId);

    const extractRes = await gateway().runStructured<MemoExtraction>({
      kind: 'structured',
      task: 'project_memo_extract_thinking',
      tenant_id: tenant.id,
      model_override: 'claude-opus-4-7',
      prompt: buildExtractionPrompt(transcript, photoFiles.length),
      schema: EXTRACTION_SCHEMA,
      files: photoFiles,
      thinking: { budget_tokens: 4000 },
      max_tokens: 8000,
    });

    const v1 =
      existing && typeof existing === 'object' && 'v1' in existing
        ? ((existing as { v1: unknown }).v1 as MemoExtraction | null)
        : (existing as unknown as MemoExtraction | null);

    const envelope: MemoExtractionEnvelope = {
      v1: v1 ?? null,
      v2: extractRes.data,
      active: 'v2',
    };

    await supabase
      .from('project_memos')
      .update({
        ai_extraction: envelope as unknown as Record<string, unknown>,
        status: 'ready',
      })
      .eq('id', memoId);

    revalidatePath(`/projects/${memo.project_id}`);
    return { ok: true, id: memoId };
  } catch (err) {
    // Don't mark the memo as failed — v1 is still valid. Just bounce
    // back to ready so the UI exits the "rethinking" state.
    await supabase.from('project_memos').update({ status: 'ready' }).eq('id', memoId);
    return {
      ok: false,
      error: `Second pass failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Flip which extraction version the UI shows + work-item edits target.
 */
export async function setActiveMemoVersionAction(
  memoId: string,
  version: MemoVersion,
): Promise<MemoDeleteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();
  const { data: memo, error: loadErr } = await supabase
    .from('project_memos')
    .select('id, project_id, ai_extraction')
    .eq('id', memoId)
    .maybeSingle();

  if (loadErr || !memo) return { ok: false, error: 'Memo not found.' };

  const envelope = (memo.ai_extraction as Record<string, unknown> | null) ?? null;
  if (!envelope || !('v1' in envelope)) {
    return { ok: false, error: 'Memo extraction is not in versioned shape.' };
  }
  if (version === 'v2' && !envelope.v2) {
    return { ok: false, error: 'No v2 extraction to switch to yet.' };
  }

  const { error: updateErr } = await supabase
    .from('project_memos')
    .update({ ai_extraction: { ...envelope, active: version } })
    .eq('id', memoId);

  if (updateErr) return { ok: false, error: updateErr.message };
  revalidatePath(`/projects/${memo.project_id as string}`);
  return { ok: true };
}

/**
 * Rewrite the work_items array of the memo's *active* extraction version,
 * dropping the item at `itemIndex`. Used when a work item is either added
 * to cost lines or dismissed.
 *
 * Tolerates the legacy flat shape (pre-migration-0174 rows): if
 * ai_extraction has a top-level `work_items`, treat it as v1.
 */
async function removeWorkItemAtIndex(
  supabase: Awaited<ReturnType<typeof createClient>>,
  memoId: string,
  itemIndex: number,
): Promise<{ ok: true; projectId: string } | { ok: false; error: string }> {
  const { data: memo, error } = await supabase
    .from('project_memos')
    .select('id, project_id, ai_extraction')
    .eq('id', memoId)
    .maybeSingle();

  if (error || !memo) return { ok: false, error: 'Memo not found.' };

  const raw = (memo.ai_extraction as Record<string, unknown> | null) ?? {};
  const isVersioned = 'v1' in raw || 'v2' in raw || 'active' in raw;
  const envelope: MemoExtractionEnvelope = isVersioned
    ? {
        v1: (raw.v1 as MemoExtraction | null) ?? null,
        v2: (raw.v2 as MemoExtraction | null) ?? null,
        active: (raw.active as MemoVersion) ?? 'v1',
      }
    : { v1: raw as unknown as MemoExtraction, v2: null, active: 'v1' };

  const slot = envelope[envelope.active];
  if (!slot) return { ok: false, error: 'Active extraction is empty.' };

  const items = Array.isArray(slot.work_items) ? [...slot.work_items] : [];
  if (itemIndex < 0 || itemIndex >= items.length) {
    return { ok: false, error: 'Work item index out of range.' };
  }
  items.splice(itemIndex, 1);

  const updated: MemoExtractionEnvelope = {
    ...envelope,
    [envelope.active]: { ...slot, work_items: items },
  };

  const { error: updateErr } = await supabase
    .from('project_memos')
    .update({ ai_extraction: updated as unknown as Record<string, unknown> })
    .eq('id', memoId);

  if (updateErr) return { ok: false, error: updateErr.message };
  return { ok: true, projectId: memo.project_id as string };
}

export type MemoItemCostLineInput = {
  memoId: string;
  itemIndex: number;
  budget_category_id: string;
  category: 'material' | 'labour' | 'sub' | 'equipment' | 'overhead';
  label: string;
  qty: number;
  unit: string;
  unit_cost_cents: number;
};

/**
 * Create a project_cost_lines row from a memo work item, then remove that
 * item from the memo's extracted list.
 */
export async function addMemoItemToCostLinesAction(
  input: MemoItemCostLineInput,
): Promise<MemoDeleteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  if (!input.label.trim()) return { ok: false, error: 'Label is required.' };
  if (!input.budget_category_id) return { ok: false, error: 'Category is required.' };
  if (input.qty <= 0) return { ok: false, error: 'Quantity must be positive.' };

  const supabase = await createClient();

  // Look up the memo for project_id (scoped to tenant via RLS).
  const { data: memo, error: loadErr } = await supabase
    .from('project_memos')
    .select('id, project_id')
    .eq('id', input.memoId)
    .maybeSingle();

  if (loadErr || !memo) return { ok: false, error: 'Memo not found.' };

  const line_cost_cents = Math.round(input.qty * input.unit_cost_cents);
  const { error: insertErr } = await supabase.from('project_cost_lines').insert({
    project_id: memo.project_id,
    budget_category_id: input.budget_category_id,
    category: input.category,
    label: input.label.trim(),
    qty: input.qty,
    unit: input.unit.trim() || 'ls',
    unit_cost_cents: input.unit_cost_cents,
    unit_price_cents: input.unit_cost_cents,
    markup_pct: 0,
    line_cost_cents,
    line_price_cents: line_cost_cents,
  });

  if (insertErr) return { ok: false, error: insertErr.message };

  const removed = await removeWorkItemAtIndex(supabase, input.memoId, input.itemIndex);
  if (!removed.ok) return removed;

  revalidatePath(`/projects/${memo.project_id}`);
  return { ok: true };
}

/**
 * Remove a work item from a memo without adding it anywhere.
 */
export async function dismissMemoItemAction(
  memoId: string,
  itemIndex: number,
): Promise<MemoDeleteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();
  const removed = await removeWorkItemAtIndex(supabase, memoId, itemIndex);
  if (!removed.ok) return removed;

  revalidatePath(`/projects/${removed.projectId}`);
  return { ok: true };
}

/**
 * Delete a memo row and its audio file from storage.
 */
export async function deleteMemoAction(memoId: string): Promise<MemoDeleteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const { data: memo, error: loadErr } = await supabase
    .from('project_memos')
    .select('id, project_id, audio_url')
    .eq('id', memoId)
    .maybeSingle();

  if (loadErr || !memo) {
    return { ok: false, error: 'Memo not found.' };
  }

  if (memo.audio_url) {
    const storagePath = (memo.audio_url as string).split('/project-memos/')[1];
    if (storagePath) {
      await supabase.storage.from('project-memos').remove([storagePath]);
    }
  }

  const { error: deleteErr } = await supabase.from('project_memos').delete().eq('id', memoId);
  if (deleteErr) {
    return { ok: false, error: deleteErr.message };
  }

  revalidatePath(`/projects/${memo.project_id}`);
  return { ok: true };
}
