'use server';

/**
 * Server actions for voice memo upload, transcription, and extraction.
 *
 * Flow: upload audio → create memo row (pending) → call Claude with audio
 * content block → extract work items + map to cost buckets → update memo row.
 */

import Anthropic from '@anthropic-ai/sdk';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type MemoActionResult = { ok: true; id: string } | { ok: false; error: string };
export type MemoDeleteResult = { ok: true } | { ok: false; error: string };

export type MemoExtraction = {
  transcript: string;
  work_items: {
    area: string;
    description: string;
    suggested_bucket: string;
    section: string;
  }[];
  customer_preferences: string[];
  uncertainty_flags: string[];
};

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

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: memo.id };
}

/**
 * Transcribe a memo's audio using Claude's audio content block and extract
 * work items mapped to renovation cost buckets.
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

    // Determine media type from the file extension.
    // Claude API accepts these audio types for document content blocks.
    const ext = storagePath.split('.').pop()?.toLowerCase();
    type AudioMediaType = 'audio/webm' | 'audio/mp3' | 'audio/mp4' | 'audio/wav' | 'audio/ogg';
    const mediaTypeMap: Record<string, AudioMediaType> = {
      webm: 'audio/webm',
      mp3: 'audio/mp3',
      mp4: 'audio/mp4',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
    };
    const mediaType: AudioMediaType = mediaTypeMap[ext ?? 'webm'] ?? 'audio/webm';

    // Update status to extracting
    await supabase.from('project_memos').update({ status: 'extracting' }).eq('id', memoId);

    // Call Claude with audio content block.
    // The SDK types may not include audio media types yet, so we cast to
    // satisfy the compiler while the API does support audio at runtime.
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: `You are a renovation project assistant. Transcribe this renovation site walk-through audio. Then extract work items and map them to standard renovation cost buckets.

Standard interior buckets: Demo, Disposal, Framing, Plumbing, Plumbing Fixtures, HVAC, Insulation, Drywall, Flooring, Doors & Mouldings, Windows & Doors, Railings, Electrical, Painting, Kitchen, Contingency.

Standard exterior buckets: Demo, Disposal, Framing, Siding, Sheathing, Painting, Gutters, Front Garden, Front Door, Rot Repair, Garage Doors, Contingency.

Respond with ONLY valid JSON in this exact format:
{
  "transcript": "full transcription of the audio",
  "work_items": [
    { "area": "room or location", "description": "what needs to be done", "suggested_bucket": "bucket name", "section": "interior or exterior" }
  ],
  "customer_preferences": ["any customer preferences mentioned"],
  "uncertainty_flags": ["anything unclear or that needs clarification"]
}`,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document' as const,
              source: {
                type: 'base64' as const,
                // Audio media types are supported at runtime but not yet in SDK types
                media_type: mediaType as unknown as 'application/pdf',
                data: base64Audio,
              },
            },
            {
              type: 'text',
              text: 'Transcribe this renovation walk-through and extract work items.',
            },
          ],
        },
      ],
    });

    // Parse the response
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude.');
    }

    let extraction: MemoExtraction;
    try {
      extraction = JSON.parse(textBlock.text);
    } catch {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = textBlock.text.match(/```(?:json)?\s*([\s\S]*?)```/);
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
