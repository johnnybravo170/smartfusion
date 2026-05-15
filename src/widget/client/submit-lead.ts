/**
 * HeyHenry lead-capture client module — copy this file into a tenant's
 * own website repo (Next.js / Vite / plain JS) and call `submitLead()`
 * from their existing contact form's submit handler. The module has
 * zero opinion on visual design — the host site keeps its layout,
 * fonts, button colors, validation UX, success/error rendering. We
 * just handle the API plumbing.
 *
 * Pipeline (per submission):
 *   1. For each photo: POST /api/widget/signed-upload-url → returns
 *      a one-shot signed PUT URL into Supabase Storage scoped to the
 *      tenant's prefix.
 *   2. PUT bytes to that URL (direct to Supabase — bypasses Vercel's
 *      4.5 MB body cap so 10 MB iPhone HEIC photos go through cleanly).
 *   3. POST /api/widget/submit with the text fields + the list of
 *      uploaded paths. Server creates an `intake_drafts` row, runs
 *      the AI classifier server-side, emails the contractor.
 *
 * Token (`wgt_...`) is a public-key-style identifier — safe to ship in
 * `NEXT_PUBLIC_HEYHENRY_TOKEN` (or equivalent). Abuse is gated by per-IP
 * + per-token rate limits on the API side, not by token secrecy.
 *
 * Usage in a Next.js form:
 *
 *   import { submitLead } from '@/lib/heyhenry/submit-lead';
 *
 *   const handleSubmit = async (e: FormEvent) => {
 *     e.preventDefault();
 *     setSubmitting(true);
 *     const result = await submitLead({
 *       token: process.env.NEXT_PUBLIC_HEYHENRY_TOKEN!,
 *       name,
 *       phone,
 *       email: email || null,
 *       description,
 *       photos,
 *     });
 *     setSubmitting(false);
 *     if (result.ok) {
 *       setStatus('sent');
 *     } else {
 *       setStatus(`Couldn't send: ${result.error}. You can also email us at hello@…`);
 *     }
 *   };
 */

const DEFAULT_API_BASE = 'https://app.heyhenry.io';
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const ALLOWED_PHOTO_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);

export type SubmitLeadInput = {
  /**
   * The contractor's widget token (e.g. `wgt_RrJaaKFKDObONQ-pSR-wNezF`).
   * Provided to the contractor when their HeyHenry tenant is set up.
   */
  token: string;
  name: string;
  phone: string;
  email?: string | null;
  description: string;
  /**
   * Optional photos. Each is uploaded directly to Supabase via a
   * one-shot signed URL — files up to 25 MB are fine, larger ones are
   * skipped. Mime allow-list: jpeg, png, heic, heif, webp.
   */
  photos?: File[];
  /**
   * Override the API base. Defaults to the production HeyHenry app.
   * Useful only for testing against a preview/staging environment.
   */
  apiBase?: string;
};

export type SubmitLeadResult =
  | {
      ok: true;
      /** UUID of the intake draft created in HeyHenry's inbox. */
      draftId: string;
      /** Photos that uploaded successfully and were attached to the draft. */
      uploadedPhotos: number;
      /** Photos that failed validation or upload — submission still went through. */
      skippedPhotos: number;
    }
  | {
      ok: false;
      error: string;
      /** True when at least one photo uploaded but the final submit failed. */
      orphanedUploads?: boolean;
    };

type SignedUploadUrlResponse = {
  ok: true;
  path: string;
  uploadUrl: string;
  token: string;
};

type SubmitResponse = {
  ok: true;
  draftId: string;
};

async function uploadOnePhoto(
  apiBase: string,
  token: string,
  photo: File,
): Promise<{ path: string; mime: string } | null> {
  if (!ALLOWED_PHOTO_MIMES.has(photo.type)) return null;
  if (photo.size <= 0 || photo.size > MAX_PHOTO_BYTES) return null;

  // Mint a signed upload URL scoped to the tenant.
  const signedRes = await fetch(`${apiBase}/api/widget/signed-upload-url`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mime: photo.type, sizeBytes: photo.size }),
  });
  if (!signedRes.ok) return null;
  const signedJson = (await signedRes.json()) as SignedUploadUrlResponse | { ok: false };
  if (!('uploadUrl' in signedJson) || !signedJson.uploadUrl) return null;

  // PUT the bytes direct to Supabase. The signed URL embeds the auth
  // token so no additional Authorization header is needed.
  const putRes = await fetch(signedJson.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': photo.type },
    body: photo,
  });
  if (!putRes.ok) return null;

  return { path: signedJson.path, mime: photo.type };
}

export async function submitLead(input: SubmitLeadInput): Promise<SubmitLeadResult> {
  const apiBase = (input.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');

  // Cheap client-side validation. The server validates again — these
  // are just for nicer error messages before any network calls.
  const name = input.name.trim();
  const phone = input.phone.trim();
  const description = input.description.trim();
  const email = input.email?.trim() || null;
  if (!name) return { ok: false, error: 'Name is required.' };
  if (!phone) return { ok: false, error: 'Phone is required.' };
  if (!description) return { ok: false, error: 'Please tell us about your project.' };

  // Upload photos sequentially. Parallel uploads risk hitting the
  // signed-upload-url rate limit (10 / hr / IP) on a slow connection
  // where the user retries. Sequential is plenty fast for 3-10 photos.
  const attachments: Array<{ path: string; mime: string }> = [];
  let skipped = 0;
  for (const photo of input.photos ?? []) {
    const uploaded = await uploadOnePhoto(apiBase, input.token, photo);
    if (uploaded) {
      attachments.push(uploaded);
    } else {
      skipped += 1;
    }
  }

  // Final submit.
  let submitRes: Response;
  try {
    submitRes = await fetch(`${apiBase}/api/widget/submit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, phone, email, description, attachments }),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error.',
      orphanedUploads: attachments.length > 0,
    };
  }

  if (!submitRes.ok) {
    let serverError = `Request failed (${submitRes.status}).`;
    try {
      const body = (await submitRes.json()) as { error?: string };
      if (body.error) serverError = body.error;
    } catch {
      // Fall through to the generic status-code message.
    }
    return {
      ok: false,
      error: serverError,
      orphanedUploads: attachments.length > 0,
    };
  }

  const submitJson = (await submitRes.json()) as SubmitResponse | { ok: false; error?: string };
  if (!('draftId' in submitJson)) {
    return {
      ok: false,
      error: ('error' in submitJson && submitJson.error) || 'Unknown server response.',
      orphanedUploads: attachments.length > 0,
    };
  }

  return {
    ok: true,
    draftId: submitJson.draftId,
    uploadedPhotos: attachments.length,
    skippedPhotos: skipped,
  };
}
