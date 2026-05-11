/**
 * QBO OAuth callback route.
 *
 * GET /api/qbo/callback?code=...&state=...&realmId=...
 *
 * Intuit redirects here after the user approves the connection.
 * We verify the state (CSRF defense), exchange the code for tokens,
 * persist them on the tenant row, and bounce back to /settings with
 * a status query param the connect card consumes.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { fetchCompanyInfo } from '@/lib/qbo/client';
import { getQboEnv } from '@/lib/qbo/env';
import { exchangeCodeForTokens, type QboTokens, verifyState } from '@/lib/qbo/oauth';
import { saveConnection } from '@/lib/qbo/tokens';

function settingsUrl(req: NextRequest, qboParam: string): URL {
  const url = new URL('/settings', req.nextUrl.origin);
  url.searchParams.set('qbo', qboParam);
  return url;
}

export async function GET(req: NextRequest): Promise<Response> {
  const code = req.nextUrl.searchParams.get('code');
  const stateParam = req.nextUrl.searchParams.get('state');
  const realmId = req.nextUrl.searchParams.get('realmId');
  const errorParam = req.nextUrl.searchParams.get('error');

  // User clicked Cancel / Intuit returned an error.
  if (errorParam || !code || !stateParam || !realmId) {
    if (errorParam) {
      console.error('[qbo.callback] intuit_error', { error: errorParam });
    }
    return NextResponse.redirect(settingsUrl(req, errorParam ? 'denied' : 'invalid'));
  }

  // State verification — CSRF defense.
  const state = verifyState(stateParam);
  if (!state) {
    console.error('[qbo.callback] state_verification_failed');
    return NextResponse.redirect(settingsUrl(req, 'invalid'));
  }

  // Exchange the auth code for tokens.
  let tokens: QboTokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    console.error('[qbo.callback] token_exchange_failed', {
      tenant_id: state.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.redirect(settingsUrl(req, 'error'));
  }

  // Persist the connection. Mark `connected_at` only on initial connect.
  const env = getQboEnv();
  try {
    await saveConnection(state.tenantId, realmId, tokens, {
      environment: env.environment,
      markConnected: true,
    });
  } catch (err) {
    console.error('[qbo.callback] save_failed', {
      tenant_id: state.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.redirect(settingsUrl(req, 'error'));
  }

  // Best-effort: fetch CompanyInfo and store the display name. Failure
  // here doesn't break the connection — we just leave the name blank.
  const info = await fetchCompanyInfo(state.tenantId);
  if (info) {
    await saveConnection(state.tenantId, realmId, tokens, {
      environment: env.environment,
      companyName: info.companyName,
    });
  }

  return NextResponse.redirect(settingsUrl(req, 'connected'));
}
