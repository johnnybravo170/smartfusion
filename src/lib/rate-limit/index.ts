/**
 * Sliding-window rate limiter, Postgres-backed.
 *
 * No new vendor (no Upstash/Redis). One row per attempt in
 * `rate_limit_attempts`; counts rows in the window for the given bucket.
 *
 * Usage:
 *   const r = await checkRateLimit('signup:ip:1.2.3.4', { limit: 5, windowMs: 10 * 60_000 });
 *   if (!r.ok) return { error: `Too many attempts. Try again in ${Math.ceil(r.retryAfterMs / 1000)}s.` };
 *
 * The check is best-effort: if Postgres is unavailable we fall open and
 * let the request through. Dropping a legitimate signup is worse than
 * letting a burst slip past for the brief moment the DB is down.
 *
 * For sensitive callers (e.g. SMS sends) consider combining multiple
 * buckets (per-IP + per-destination) so an attacker can't drain the
 * window from many IPs.
 */

import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';

export type RateLimitResult =
  | { ok: true; remaining: number; retryAfterMs: 0 }
  | { ok: false; remaining: 0; retryAfterMs: number };

export type RateLimitOptions = {
  /** Max allowed attempts in the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export async function checkRateLimit(
  bucket: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  if (!bucket || opts.limit <= 0 || opts.windowMs <= 0) {
    return { ok: true, remaining: opts.limit, retryAfterMs: 0 };
  }

  const admin = createAdminClient();
  const since = new Date(Date.now() - opts.windowMs).toISOString();

  // Count attempts in window. Order by attempted_at ASC so the oldest is
  // first — we use it to compute retryAfterMs when over the limit.
  const { data: rows, error: countErr } = await admin
    .from('rate_limit_attempts')
    .select('attempted_at')
    .eq('bucket', bucket)
    .gte('attempted_at', since)
    .order('attempted_at', { ascending: true })
    .limit(opts.limit);

  if (countErr) {
    console.warn(`[rate-limit] fall-open on bucket=${bucket}: ${countErr.message}`);
    return { ok: true, remaining: opts.limit, retryAfterMs: 0 };
  }

  const count = rows?.length ?? 0;
  if (count >= opts.limit) {
    const oldest = rows?.[0]?.attempted_at as string | undefined;
    const expiresAt = oldest
      ? new Date(oldest).getTime() + opts.windowMs
      : Date.now() + opts.windowMs;
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(0, expiresAt - Date.now()),
    };
  }

  // Under the limit — log this attempt. Failure to log isn't fatal; we'd
  // rather process the request than block legit traffic.
  await admin
    .from('rate_limit_attempts')
    .insert({ bucket })
    .then(({ error }) => {
      if (error) {
        console.warn(`[rate-limit] failed to log attempt for ${bucket}: ${error.message}`);
      }
    });

  return { ok: true, remaining: opts.limit - count - 1, retryAfterMs: 0 };
}

/**
 * Read the caller's IP from request headers. Vercel sets x-forwarded-for;
 * the first hop in the list is the client. Returns `'unknown'` if we
 * can't tell — buckets are still rate-limited but coalesced.
 */
export async function callerIp(): Promise<string> {
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = h.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

/**
 * Human-readable retry-after for error messages.
 */
export function describeRetryAfter(retryAfterMs: number): string {
  const seconds = Math.ceil(retryAfterMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
