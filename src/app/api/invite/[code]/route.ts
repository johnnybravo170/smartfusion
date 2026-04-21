import { findWorkerInviteByCode } from '@/lib/db/queries/worker-invites';
import { createAdminClient } from '@/lib/supabase/admin';

const LOGO_SIGN_SECONDS = 60 * 60 * 24; // 24h is plenty; invites are short-lived

/**
 * GET /api/invite/:code
 *
 * Public endpoint for the join page to validate an invite code and
 * display the tenant name + logo before the user fills in the signup form.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  const invite = await findWorkerInviteByCode(code);
  if (!invite) {
    return Response.json({ valid: false }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data: tenant } = await admin
    .from('tenants')
    .select('logo_storage_path')
    .eq('id', invite.tenant_id)
    .maybeSingle();

  let logoUrl: string | null = null;
  const logoPath = (tenant?.logo_storage_path as string | null) ?? null;
  if (logoPath) {
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrl(logoPath, LOGO_SIGN_SECONDS);
    logoUrl = signed?.signedUrl ?? null;
  }

  return Response.json({
    valid: true,
    tenantName: invite.tenant_name,
    logoUrl,
  });
}
