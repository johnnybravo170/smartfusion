/**
 * Widget token resolution and origin enforcement for the embeddable
 * conversational lead-intake widget.
 *
 * The widget calls /api/widget/* with `Authorization: Bearer wgt_...`. The
 * token is public-key-style — it identifies the tenant but doesn't
 * authenticate a human. Abuse is bounded by rate limits + the
 * allowed_origins allow-list on widget_configs.
 */

import { randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

export type WidgetConfig = {
  id: string;
  tenantId: string;
  token: string;
  enabled: boolean;
  photosEnabled: boolean;
  accentColor: string | null;
  whiteLabelDisabled: boolean;
  allowedOrigins: string[];
};

export type WidgetAuthResult =
  | { ok: true; config: WidgetConfig }
  | { ok: false; status: 401 | 403 | 404; error: string };

const TOKEN_PREFIX = 'wgt_';
const TOKEN_RANDOM_BYTES = 18; // 18 bytes → 24 base64url chars

/**
 * Mint a new widget token. Format: `wgt_<24 url-safe chars>`. Caller is
 * responsible for inserting/updating the widget_configs row.
 */
export function generateWidgetToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString('base64url');
}

/**
 * Resolve a widget token to its config. Returns `null` for unknown tokens
 * so the caller can return a generic 401 without leaking existence.
 *
 * Uses the admin client because the request has no user session — the
 * widget runs on the homeowner's browser on the contractor's website.
 */
export async function resolveWidgetToken(
  token: string | null | undefined,
): Promise<WidgetConfig | null> {
  if (!token?.startsWith(TOKEN_PREFIX)) return null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('widget_configs')
    .select(
      'id, tenant_id, token, enabled, photos_enabled, accent_color, white_label_disabled, allowed_origins',
    )
    .eq('token', token)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    tenantId: data.tenant_id,
    token: data.token,
    enabled: data.enabled,
    photosEnabled: data.photos_enabled,
    accentColor: data.accent_color,
    whiteLabelDisabled: data.white_label_disabled,
    allowedOrigins: data.allowed_origins ?? [],
  };
}

/**
 * Extract the bearer token from an Authorization header.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  return match?.[1] ?? null;
}

/**
 * Check that the request `Origin` header is on the config's allow-list.
 * Empty allow-list = anywhere (V1 default for tenants who haven't locked
 * the widget down yet).
 */
export function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  if (!origin) return false;
  // Normalise — drop trailing slash, lowercase the host.
  const normalised = origin.replace(/\/$/, '').toLowerCase();
  return allowedOrigins.some((o) => o.replace(/\/$/, '').toLowerCase() === normalised);
}

/**
 * One-call auth-and-origin gate for /api/widget/* routes. Returns the
 * config on success or a structured error to return as JSON.
 */
export async function authenticateWidgetRequest(args: {
  authHeader: string | null;
  origin: string | null;
}): Promise<WidgetAuthResult> {
  const token = extractBearerToken(args.authHeader);
  if (!token) {
    return { ok: false, status: 401, error: 'missing_token' };
  }

  const config = await resolveWidgetToken(token);
  if (!config) {
    return { ok: false, status: 401, error: 'invalid_token' };
  }

  if (!config.enabled) {
    return { ok: false, status: 403, error: 'widget_disabled' };
  }

  if (!isOriginAllowed(args.origin, config.allowedOrigins)) {
    return { ok: false, status: 403, error: 'origin_not_allowed' };
  }

  return { ok: true, config };
}
