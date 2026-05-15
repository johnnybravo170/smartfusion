/**
 * CORS headers for the public /api/widget/* surface.
 *
 * Open by default — the bearer token gates access, not the origin. When
 * `widget_configs.allowed_origins` is non-empty the route handler also
 * enforces an Origin allow-list (see `lib/widget/auth.ts`), but the
 * browser still needs the basic CORS headers for the preflight.
 */

export function widgetCorsHeaders(requestOrigin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': requestOrigin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
