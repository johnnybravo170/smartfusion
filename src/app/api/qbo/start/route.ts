/**
 * QBO OAuth start route.
 *
 * GET /api/qbo/start
 *   - Requires an authenticated tenant member.
 *   - Mints a signed state cookie keyed to the tenant.
 *   - Redirects to Intuit's authorize endpoint.
 */

import { redirect } from 'next/navigation';
import { type NextRequest, NextResponse } from 'next/server';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getQboEnv, QBO_OAUTH_AUTHORIZE_URL, QBO_OAUTH_SCOPES } from '@/lib/qbo/env';
import { signState } from '@/lib/qbo/oauth';

export async function GET(_req: NextRequest): Promise<Response> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    redirect('/login?next=/settings');
  }

  const env = getQboEnv();
  const state = signState(tenant.id);

  const url = new URL(QBO_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', env.clientId);
  url.searchParams.set('redirect_uri', env.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', QBO_OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', state);

  return NextResponse.redirect(url.toString());
}
