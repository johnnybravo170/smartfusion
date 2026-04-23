/**
 * OAuth 2.1 authorization endpoint.
 *
 * Lives inside the (auth) layout group so the existing Supabase session +
 * MFA gate (`requireAdmin`) bounces unauthenticated users to /login first.
 *
 * Single-user system, so the consent screen is one button — but we still
 * surface the requesting client_id and the scopes being granted so it's
 * obvious what's happening.
 */
import { ALLOWED_REDIRECT_PREFIX, SUPPORTED_SCOPES } from '@/lib/oauth';
import { createServiceClient } from '@/lib/supabase';
import { approveAuthorizationAction } from './actions';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function asStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const response_type = asStr(sp.response_type);
  const client_id = asStr(sp.client_id);
  const redirect_uri = asStr(sp.redirect_uri);
  const code_challenge = asStr(sp.code_challenge);
  const code_challenge_method = asStr(sp.code_challenge_method);
  const state = asStr(sp.state);
  const requestedScope = asStr(sp.scope);

  const errors: string[] = [];
  if (response_type !== 'code') errors.push('response_type must be "code"');
  if (!client_id) errors.push('client_id is required');
  if (!code_challenge) errors.push('code_challenge is required');
  if (code_challenge_method !== 'S256') errors.push('code_challenge_method must be "S256"');
  if (!redirect_uri.startsWith(ALLOWED_REDIRECT_PREFIX)) {
    errors.push(`redirect_uri must start with ${ALLOWED_REDIRECT_PREFIX}`);
  }

  // Resolve the client. Two supported modes:
  //   1. DCR — client was registered at /register, lookup in ops.oauth_clients
  //   2. CIMD — client_id is an https:// URL pointing to a metadata JSON doc
  //      (RFC-ish — what Anthropic actually uses). Fetch it, cache in
  //      ops.oauth_clients, use its redirect_uris to validate.
  let clientName: string | null = null;
  if (client_id && errors.length === 0) {
    const service = createServiceClient();
    let registeredRedirects: string[] = [];

    if (client_id.startsWith('https://')) {
      // CIMD path
      try {
        const res = await fetch(client_id, { headers: { accept: 'application/json' } });
        if (!res.ok) {
          errors.push(`Could not fetch client metadata at ${client_id} (status ${res.status})`);
        } else {
          const meta = (await res.json()) as {
            client_name?: string;
            redirect_uris?: string[];
          };
          registeredRedirects = meta.redirect_uris ?? [];
          clientName = meta.client_name ?? null;
          // Cache in ops.oauth_clients so /token can look it up by client_id.
          await service
            .schema('ops')
            .from('oauth_clients')
            .upsert(
              {
                client_id,
                client_name: clientName,
                redirect_uris: registeredRedirects,
                grant_types: ['authorization_code', 'refresh_token'],
                token_endpoint_auth_method: 'none',
              },
              { onConflict: 'client_id' },
            );
        }
      } catch (e) {
        errors.push(
          `Failed to fetch client metadata: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      // DCR path
      const { data: clientRow } = await service
        .schema('ops')
        .from('oauth_clients')
        .select('client_id, client_name, redirect_uris')
        .eq('client_id', client_id)
        .maybeSingle();
      if (!clientRow) {
        errors.push(`invalid_client: ${client_id} not registered`);
      } else {
        registeredRedirects = (clientRow.redirect_uris as string[]) ?? [];
        clientName = (clientRow.client_name as string | null) ?? null;
      }
    }

    if (errors.length === 0 && !registeredRedirects.includes(redirect_uri)) {
      errors.push('redirect_uri does not match a registered redirect_uri for this client');
    }
  }

  if (errors.length > 0) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Invalid authorization request</h1>
        <ul className="list-disc pl-5 text-sm text-red-700">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    );
  }

  // Default-grant all scopes (single-user, no consent UI complexity), but
  // honor a narrower `scope=` query if the client passed one.
  const requestedScopes = requestedScope
    ? requestedScope.split(/\s+/).filter((s) => SUPPORTED_SCOPES.includes(s))
    : [...SUPPORTED_SCOPES];
  const grantedScopes = requestedScopes.length > 0 ? requestedScopes : [...SUPPORTED_SCOPES];

  async function approve() {
    'use server';
    await approveAuthorizationAction({
      client_id,
      redirect_uri,
      code_challenge,
      state,
      scopes: grantedScopes,
    });
  }

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <h1 className="text-xl font-semibold">Authorize MCP access</h1>
      <p className="text-sm text-[var(--muted-foreground)]">
        Connect <strong>{clientName ?? client_id}</strong> to your HeyHenry ops MCP server?
      </p>

      <div className="rounded-md border border-[var(--border)] bg-white p-4 text-xs">
        <div className="mb-2 font-medium">Granting these scopes:</div>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-[var(--muted-foreground)]">
          {grantedScopes.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>

      <div className="text-xs text-[var(--muted-foreground)]">
        Redirecting back to <code>{redirect_uri}</code> after approval.
      </div>

      <form action={approve} className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)]"
        >
          Approve
        </button>
      </form>
    </div>
  );
}
