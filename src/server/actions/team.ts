'use server';

/**
 * Server actions for team management: invite generation, member listing,
 * member removal, and invite revocation.
 *
 * All actions require the caller to be authenticated with an owner or admin
 * role. Tenant context is resolved via getCurrentTenant().
 */

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { guardMfaForSensitiveAction } from '@/lib/auth/mfa-enforcement';
import { listTeamMembers, removeTeamMember } from '@/lib/db/queries/team';
import {
  createWorkerInvite,
  deleteInvite,
  type InvitePrefs,
  type InviteRole,
  listInvitesByTenantId,
  revokeInvite,
} from '@/lib/db/queries/worker-invites';

async function originFromHeaders(): Promise<string> {
  const h = await headers();
  const origin = h.get('origin');
  if (origin) return origin;
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

function assertOwnerOrAdmin(role: string) {
  if (role !== 'owner' && role !== 'admin') {
    throw new Error('Only owners and admins can manage the team.');
  }
}

export async function createWorkerInviteAction(input?: {
  role?: InviteRole;
  invited_name?: string;
  invited_email?: string;
  invite_prefs?: InvitePrefs;
}): Promise<{
  ok: boolean;
  code?: string;
  joinUrl?: string;
  error?: string;
}> {
  const block = await guardMfaForSensitiveAction();
  if (block) return block;

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch {
    return { ok: false, error: 'Only owners and admins can create invites.' };
  }

  try {
    const invite = await createWorkerInvite(tenant.id, tenant.member.id, {
      role: input?.role ?? 'worker',
      invited_name: input?.invited_name || undefined,
      invited_email: input?.invited_email || undefined,
      invite_prefs: input?.invite_prefs,
    });
    const origin = await originFromHeaders();
    const joinUrl = `${origin}/join/${invite.code}`;

    // Auto-send email if an address was provided.
    if (input?.invited_email) {
      try {
        const { sendEmail } = await import('@/lib/email/send');
        const name = input.invited_name ? ` for ${input.invited_name}` : '';
        await sendEmail({
          tenantId: tenant.id,
          to: input.invited_email,
          subject: `You're invited to join ${tenant.name} on HeyHenry`,
          html: `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #0a0a0a;">${tenant.name} has invited you${name} to join their team</h2>
  <p>You've been invited to join <strong>${tenant.name}</strong> on HeyHenry as a team member.</p>
  <p>Click the button below to create your account and get started:</p>
  <p>
    <a href="${joinUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Join the team
    </a>
  </p>
  <p style="color: #666; font-size: 14px;">This invite expires in 7 days.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;"><a href="https://heyhenry.io/?utm_source=tenant_email&amp;utm_medium=referral&amp;utm_campaign=sent_via_footer&amp;utm_content=team_invite" style="color:inherit;text-decoration:none">Sent via HeyHenry</a></p>
</body>
</html>`,
          caslCategory: 'transactional',
          relatedType: 'team',
          relatedId: invite.code,
          caslEvidence: { kind: 'team_invite', inviteCode: invite.code },
        });
      } catch {
        // Email failure is non-fatal — return the link so the owner can share manually.
      }
    }

    revalidatePath('/settings/team');
    return { ok: true, code: invite.code, joinUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to create invite.' };
  }
}

export async function listTeamMembersAction() {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false as const, error: 'Not signed in.', members: [] };

  try {
    const members = await listTeamMembers(tenant.id);
    return { ok: true as const, members };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : 'Failed to load team.',
      members: [],
    };
  }
}

export async function removeTeamMemberAction(
  memberId: string,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch {
    return { ok: false, error: 'Only owners and admins can remove members.' };
  }

  // Prevent self-removal.
  if (memberId === tenant.member.id) {
    return { ok: false, error: 'You cannot remove yourself.' };
  }

  try {
    await removeTeamMember(tenant.id, memberId);
    revalidatePath('/settings/team');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to remove member.' };
  }
}

export async function listInvitesAction() {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false as const, error: 'Not signed in.', invites: [] };

  try {
    const invites = await listInvitesByTenantId(tenant.id);
    return { ok: true as const, invites };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : 'Failed to load invites.',
      invites: [],
    };
  }
}

export async function revokeInviteAction(
  inviteId: string,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch {
    return { ok: false, error: 'Only owners and admins can revoke invites.' };
  }

  try {
    await revokeInvite(inviteId);
    revalidatePath('/settings/team');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to revoke invite.' };
  }
}

export async function deleteInviteAction(
  inviteId: string,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch {
    return { ok: false, error: 'Only owners and admins can delete invites.' };
  }

  try {
    await deleteInvite(inviteId);
    revalidatePath('/settings/team');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to delete invite.' };
  }
}

export async function sendWorkerInviteEmailAction(
  email: string,
  joinUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch {
    return { ok: false, error: 'Only owners and admins can send invites.' };
  }

  try {
    const { sendEmail } = await import('@/lib/email/send');
    const result = await sendEmail({
      tenantId: tenant.id,
      to: email,
      subject: `You're invited to join ${tenant.name} on HeyHenry`,
      caslCategory: 'transactional',
      relatedType: 'team',
      caslEvidence: { kind: 'team_invite_resend' },
      html: `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #0a0a0a;">${tenant.name} has invited you to join their team</h2>
  <p>You've been invited to join <strong>${tenant.name}</strong> on HeyHenry as a team member.</p>
  <p>Click the button below to create your account and get started:</p>
  <p>
    <a href="${joinUrl}" style="display: inline-block; padding: 12px 24px; background: #0a0a0a; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Join the team
    </a>
  </p>
  <p style="color: #666; font-size: 14px;">This invite expires in 7 days.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #999; font-size: 12px;"><a href="https://heyhenry.io/?utm_source=tenant_email&amp;utm_medium=referral&amp;utm_campaign=sent_via_footer&amp;utm_content=team_invite" style="color:inherit;text-decoration:none">Sent via HeyHenry</a></p>
</body>
</html>`,
    });

    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Failed to send email.' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to send invite.' };
  }
}
