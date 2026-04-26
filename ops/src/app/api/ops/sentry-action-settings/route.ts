/**
 * Settings-validation endpoint for the Sentry Internal Integration's
 * alert-rule-action UI component (see ops-incidents schema).
 *
 * Sentry POSTs here when:
 *   - The user opens/saves the action settings dialog on an alert rule
 *   - Sentry validates the rule before persisting it
 *
 * It is NOT where alert events land — that's `/api/ops/sentry-webhook`,
 * which verifies an HMAC signature. This config endpoint accepts whatever
 * Sentry sends and returns 200 so save flows succeed.
 */

import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({ ok: true });
}
