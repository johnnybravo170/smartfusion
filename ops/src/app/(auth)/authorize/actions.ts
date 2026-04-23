'use server';

import { redirect } from 'next/navigation';
import {
  ALLOWED_REDIRECT_PREFIX,
  AUTH_CODE_TTL_SECONDS,
  generateOpaqueToken,
  SUPPORTED_SCOPES,
} from '@/lib/oauth';
import { requireAdmin } from '@/lib/ops-gate';
import { createServiceClient } from '@/lib/supabase';

export type AuthorizeInput = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  scopes: string[];
};

/**
 * Mint an authorization code, store it, then redirect the browser back to
 * Anthropic's callback. Validates the same params as the GET handler does
 * since this is a server action callable independently.
 */
export async function approveAuthorizationAction(input: AuthorizeInput): Promise<void> {
  const admin = await requireAdmin();

  if (!input.client_id) throw new Error('client_id required');
  if (!input.code_challenge) throw new Error('code_challenge required');
  if (!input.redirect_uri.startsWith(ALLOWED_REDIRECT_PREFIX)) {
    throw new Error('redirect_uri not allowed');
  }
  const validScopes = input.scopes.filter((s) => SUPPORTED_SCOPES.includes(s));
  if (validScopes.length === 0) throw new Error('at least one scope required');

  const code = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000).toISOString();

  const service = createServiceClient();
  const { error } = await service.schema('ops').from('oauth_codes').insert({
    code,
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    code_challenge: input.code_challenge,
    scopes: validScopes,
    user_id: admin.userId,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`Failed to issue code: ${error.message}`);

  const target = new URL(input.redirect_uri);
  target.searchParams.set('code', code);
  if (input.state) target.searchParams.set('state', input.state);

  // `redirect()` throws — must be the last statement.
  redirect(target.toString());
}
