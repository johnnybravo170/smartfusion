'use server';

/**
 * Server actions for the homeowner portal updates.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getEmailBrandingForTenant } from '@/lib/email/branding';
import { sendEmail } from '@/lib/email/send';
import { portalInviteEmailHtml } from '@/lib/email/templates/portal-invite';
import { uploadToStorage } from '@/lib/storage/photos';
import { createClient } from '@/lib/supabase/server';

const MAX_PORTAL_PHOTO_BYTES = 10 * 1024 * 1024;

export type PortalActionResult = { ok: true; id?: string } | { ok: false; error: string };

export async function addPortalUpdateAction(input: {
  projectId: string;
  type: 'progress' | 'photo' | 'milestone' | 'message';
  title: string;
  body?: string;
  photoUrl?: string;
}): Promise<PortalActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  if (!input.title?.trim()) {
    return { ok: false, error: 'Title is required.' };
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from('project_portal_updates')
    .insert({
      project_id: input.projectId,
      tenant_id: tenant.id,
      type: input.type,
      title: input.title.trim(),
      body: input.body?.trim() || null,
      photo_url: input.photoUrl || null,
      created_by: tenant.member.id,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to add portal update.' };
  }

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: data.id };
}

/**
 * FormData-based variant that supports uploading a photo alongside the
 * update. Uploads to the private photos bucket; portal renders via signed
 * URL.
 */
export async function addPortalUpdateWithPhotoAction(
  formData: FormData,
): Promise<PortalActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const projectId = String(formData.get('projectId') ?? '');
  const type = String(formData.get('type') ?? 'progress') as
    | 'progress'
    | 'photo'
    | 'milestone'
    | 'message';
  const title = String(formData.get('title') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();

  if (!projectId) return { ok: false, error: 'Project is required.' };
  if (!title) return { ok: false, error: 'Title is required.' };

  let photoStoragePath: string | null = null;
  const photo = formData.get('photo');
  if (photo && photo instanceof File && photo.size > 0) {
    if (photo.size > MAX_PORTAL_PHOTO_BYTES) {
      return { ok: false, error: 'Photo is larger than 10MB.' };
    }
    const ext = photo.type === 'image/png' ? 'png' : photo.type === 'image/webp' ? 'webp' : 'jpg';
    const uploaded = await uploadToStorage({
      tenantId: tenant.id,
      projectId,
      photoId: randomUUID(),
      file: photo,
      contentType: photo.type || 'image/jpeg',
      extension: ext,
    });
    if ('error' in uploaded) return { ok: false, error: uploaded.error };
    photoStoragePath = uploaded.path;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_portal_updates')
    .insert({
      project_id: projectId,
      tenant_id: tenant.id,
      type,
      title,
      body: body || null,
      photo_storage_path: photoStoragePath,
      created_by: tenant.member.id,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to add portal update.' };
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: data.id };
}

/** Generate a URL-safe slug from a project name. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function togglePortalAction(input: {
  projectId: string;
  enabled: boolean;
}): Promise<PortalActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  if (input.enabled) {
    // Load project to generate slug
    const { data: project } = await supabase
      .from('projects')
      .select('id, name, portal_slug')
      .eq('id', input.projectId)
      .single();

    if (!project) {
      return { ok: false, error: 'Project not found.' };
    }

    const slug = (project.portal_slug as string) || slugify(project.name as string);

    const { error } = await supabase
      .from('projects')
      .update({
        portal_enabled: true,
        portal_slug: slug,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.projectId);

    if (error) {
      // If slug collision, append random suffix
      if (error.message.includes('unique') || error.message.includes('duplicate')) {
        const suffix = Math.random().toString(36).slice(2, 6);
        const { error: retryErr } = await supabase
          .from('projects')
          .update({
            portal_enabled: true,
            portal_slug: `${slug}-${suffix}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.projectId);
        if (retryErr) {
          return { ok: false, error: retryErr.message };
        }
      } else {
        return { ok: false, error: error.message };
      }
    }

    // Add system portal update
    await supabase.from('project_portal_updates').insert({
      project_id: input.projectId,
      tenant_id: tenant.id,
      type: 'system',
      title: 'Portal activated',
      body: 'Homeowner portal is now live.',
      created_by: tenant.member.id,
    });
  } else {
    const { error } = await supabase
      .from('projects')
      .update({
        portal_enabled: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.projectId);

    if (error) {
      return { ok: false, error: error.message };
    }
  }

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}

export async function sendPortalInviteAction(projectId: string): Promise<PortalActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, portal_slug, portal_enabled, customers:customer_id (name, email)')
    .eq('id', projectId)
    .single();

  if (!project) {
    return { ok: false, error: 'Project not found.' };
  }

  const projectData = project as Record<string, unknown>;
  if (!projectData.portal_enabled) {
    return { ok: false, error: 'Portal is not enabled for this project.' };
  }

  const customerRaw = projectData.customers as Record<string, unknown> | null;
  const customerEmail = customerRaw?.email as string | null;
  const customerName = (customerRaw?.name as string) ?? 'Homeowner';

  if (!customerEmail) {
    return { ok: false, error: 'Customer has no email address.' };
  }

  const portalUrl = `https://app.heyhenry.io/portal/${projectData.portal_slug}`;
  const branding = await getEmailBrandingForTenant(tenant.id);
  const html = portalInviteEmailHtml({
    businessName: branding.businessName,
    logoUrl: branding.logoUrl,
    projectName: projectData.name as string,
    customerName,
    portalUrl,
  });

  const result = await sendEmail({
    tenantId: tenant.id,
    to: customerEmail,
    subject: `Your project portal — ${projectData.name}`,
    html,
    caslCategory: 'transactional',
    relatedType: 'job',
    relatedId: String(projectData.id ?? ''),
    caslEvidence: { kind: 'portal_invite', projectId: projectData.id },
  });

  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Failed to send email.' };
  }

  // Worklog
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Portal invite sent',
    body: `Portal invite sent to ${customerName} (${customerEmail}) for "${projectData.name}".`,
    related_type: 'project',
    related_id: projectId,
  });

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
