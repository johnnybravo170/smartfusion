'use server';

import { revalidatePath } from 'next/cache';
import { formatKey, generateRawSecret, hashSecret } from '@/lib/keys';
import { requireAdmin } from '@/lib/ops-gate';
import { createServiceClient } from '@/lib/supabase';

export type CreateKeyResult = { ok: true; rawKey: string } | { ok: false; error: string };

export async function createKeyAction(input: {
  name: string;
  days: number;
  scopes: string[];
}): Promise<CreateKeyResult> {
  const admin = await requireAdmin();
  if (!input.name.trim()) return { ok: false, error: 'Name required.' };
  if (input.scopes.length === 0) return { ok: false, error: 'At least one scope required.' };
  const days = Math.max(1, Math.min(365, Math.floor(input.days)));

  const service = createServiceClient();
  const secret = generateRawSecret();
  const secretHash = await hashSecret(secret);
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();

  const { data, error } = await service
    .schema('ops')
    .from('api_keys')
    .insert({
      name: input.name.trim(),
      owner_user_id: admin.userId,
      scopes: input.scopes,
      secret_hash: secretHash,
      expires_at: expiresAt,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create key.' };
  }

  revalidatePath('/admin/keys');
  return { ok: true, rawKey: formatKey(data.id as string, secret) };
}

export async function revokeKeyAction(
  id: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = await requireAdmin();
  if (!reason.trim()) return { ok: false, error: 'Reason required.' };

  const service = createServiceClient();
  const { error } = await service
    .schema('ops')
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };

  await service
    .schema('ops')
    .from('audit_log')
    .insert({
      admin_user_id: admin.userId,
      method: 'DELETE',
      path: `/admin/keys/${id}`,
      status: 200,
      reason: reason.trim(),
    });

  revalidatePath('/admin/keys');
  return { ok: true };
}
