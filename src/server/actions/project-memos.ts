'use server';

/**
 * Server actions for voice memo upload, transcription, and extraction.
 *
 * Flow: upload audio → create memo row (pending) → call Claude with audio
 * content block → extract work items + map to budget categories → update memo row.
 */

import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import {
  deleteFromStorage as deletePhotoFromStorage,
  uploadToStorage as uploadPhotoToStorage,
} from '@/lib/storage/photos';
import { createClient } from '@/lib/supabase/server';

export type MemoActionResult = { ok: true; id: string } | { ok: false; error: string };
export type MemoDeleteResult = { ok: true } | { ok: false; error: string };

export type MemoExtraction = {
  transcript: string;
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

/**
 * Transcribe a memo's audio using Claude's audio content block and extract
 * work items mapped to renovation budget categories.
 */
export async function transcribeMemoAction(memoId: string): Promise<MemoActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  // Load the memo
  const { data: memo, error: loadErr } = await supabase
    .from('project_memos')
    .select('id, project_id, audio_url, status')
    .eq('id', memoId)
    .maybeSingle();

  if (loadErr || !memo) {
    return { ok: false, error: 'Memo not found.' };
  }

  if (!memo.audio_url) {
    return { ok: false, error: 'No audio file attached to this memo.' };
  }

  // Update status to transcribing
  await supabase.from('project_memos').update({ status: 'transcribing' }).eq('id', memoId);

  try {
    // Download the audio file from storage
    const audioUrl = memo.audio_url as string;
    const storagePath = audioUrl.split('/project-memos/')[1];

    if (!storagePath) {
      throw new Error('Invalid audio URL format.');
    }

    const { data: fileData, error: downloadErr } = await supabase.storage
      .from('project-memos')
      .download(storagePath);

    if (downloadErr || !fileData) {
      throw new Error(`Failed to download audio: ${downloadErr?.message}`);
    }

    const audioBuffer = await fileData.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');

    // Gemini accepts these audio mime types for inline_data.
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

    // Update status to extracting
    await supabase.from('project_memos').update({ status: 'extracting' }).eq('id', memoId);

    // Load any photos attached to this memo — the operator typically snaps
    // a few as they talk through the walkthrough. Send them to Gemini as
    // additional inline parts so it can cross-reference what it heard with
    // what it sees.
    const { data: memoPhotos } = await supabase
      .from('photos')
      .select('id, storage_path, mime')
      .eq('memo_id', memoId)
      .order('created_at', { ascending: true });

    type PhotoPart = { mimeType: string; data: string };
    const photoParts: PhotoPart[] = [];
    for (const p of memoPhotos ?? []) {
      const path = p.storage_path as string;
      const { data: photoData } = await supabase.storage.from('photos').download(path);
      if (!photoData) continue;
      const photoBuf = await photoData.arrayBuffer();
      photoParts.push({
        mimeType: (p.mime as string) || 'image/jpeg',
        data: Buffer.from(photoBuf).toString('base64'),
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

    const ai = new GoogleGenAI({ apiKey });

    const photoInstruction =
      photoParts.length > 0
        ? `\n\n${photoParts.length} site-walk ${photoParts.length === 1 ? 'photo is' : 'photos are'} attached (in order, 0-indexed). For each work item, include a "referenced_photo_indexes" array listing the indexes of photos that show the area or condition you're describing. Empty array if none are relevant.`
        : '';

    const prompt = `You are a renovation project assistant. Transcribe this renovation site walk-through audio. Then extract work items and map them to standard renovation budget categories.

Standard interior categories: Demo, Disposal, Framing, Plumbing, Plumbing Fixtures, HVAC, Insulation, Drywall, Flooring, Doors & Mouldings, Windows & Doors, Railings, Electrical, Painting, Kitchen, Contingency.

Standard exterior categories: Demo, Disposal, Framing, Siding, Sheathing, Painting, Gutters, Front Garden, Front Door, Rot Repair, Garage Doors, Contingency.${photoInstruction}

Respond with ONLY valid JSON in this exact format:
{
  "transcript": "full transcription of the audio",
  "work_items": [
    { "area": "room or location", "description": "what needs to be done", "suggested_category": "category name", "section": "interior or exterior", "referenced_photo_indexes": [] }
  ],
  "customer_preferences": ["any customer preferences mentioned"],
  "uncertainty_flags": ["anything unclear or that needs clarification"]
}`;

    // Gemini's free tier throws 503 "model overloaded" on busy periods.
    // Retry with backoff, then fall back to the lite model.
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
    const delays = [0, 2000, 5000];

    let text = '';
    let lastErr: unknown = null;
    for (let i = 0; i < models.length; i++) {
      if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
      try {
        const response = await ai.models.generateContent({
          model: models[i],
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                { inlineData: { mimeType: mediaType, data: base64Audio } },
                ...photoParts.map((p) => ({ inlineData: p })),
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        });
        text = response.text ?? '';
        if (text) {
          lastErr = null;
          break;
        }
        lastErr = new Error('Empty response from Gemini.');
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const retryable = /\b(503|429|overload|unavailable|rate)/i.test(msg);
        if (!retryable) throw err;
      }
    }
    if (lastErr || !text) {
      throw new Error(
        `Gemini overloaded after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
    }

    let extraction: MemoExtraction;
    try {
      extraction = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        extraction = JSON.parse(jsonMatch[1]);
      } else {
        throw new Error('Failed to parse AI response as JSON.');
      }
    }

    // Update memo with results
    await supabase
      .from('project_memos')
      .update({
        transcript: extraction.transcript,
        ai_extraction: extraction as unknown as Record<string, unknown>,
        status: 'ready',
      })
      .eq('id', memoId);

    revalidatePath(`/projects/${memo.project_id}`);
    return { ok: true, id: memoId };
  } catch (err) {
    // Mark as failed
    await supabase.from('project_memos').update({ status: 'failed' }).eq('id', memoId);

    return {
      ok: false,
      error: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Rewrite a memo's ai_extraction.work_items array, dropping the item at
 * `itemIndex`. Used when a work item is either added to cost lines or
 * dismissed.
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

  const extraction = (memo.ai_extraction as Record<string, unknown>) ?? {};
  const items = Array.isArray(extraction.work_items)
    ? [...(extraction.work_items as unknown[])]
    : [];
  if (itemIndex < 0 || itemIndex >= items.length) {
    return { ok: false, error: 'Work item index out of range.' };
  }
  items.splice(itemIndex, 1);

  const { error: updateErr } = await supabase
    .from('project_memos')
    .update({ ai_extraction: { ...extraction, work_items: items } })
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
