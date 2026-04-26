/**
 * Sentry → ops incidents bridge.
 *
 * Sentry "Internal Integration" posts here on issue events and on alert
 * rule fires. We verify the `sentry-hook-signature` HMAC, normalise the
 * two payload shapes, and upsert by sentry_issue_id so re-fires bump
 * event_count rather than spawning duplicates.
 *
 * Auth: HMAC-SHA256 of the raw body using SENTRY_WEBHOOK_SECRET.
 *
 * Configure on Sentry side: Settings → Developer Settings → Internal
 * Integrations → New → Webhook URL = https://ops.heyhenry.io/api/ops/sentry-webhook
 * Permissions: Issue & Event = Read. Subscribe to: issue. Copy the client
 * secret into Vercel as SENTRY_WEBHOOK_SECRET.
 *
 * --- Payload shapes -------------------------------------------------------
 *
 * `issue` resource (issue created / resolved / assigned):
 *   { action, data: { issue: { id, title, culprit, level, count, web_url, permalink, ... } } }
 *
 * `event_alert` resource (alert rule fired on an event):
 *   { action: 'triggered', data: {
 *       event: { event_id, issue_id, title, transaction, level, release, tags: [[k,v]…],
 *                user: {id,...}, web_url, ... },
 *       triggered_rule: 'Rule name'
 *   } }
 *
 * Tags only exist on event payloads — `issue` resource fires can't be
 * enriched with tenant_id/user/route context. The richest data is from
 * `event_alert`, which is what our 3 alert rules send.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase';

type SentryLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

const SEVERITY_BY_LEVEL: Record<SentryLevel, 'critical' | 'high' | 'med' | 'low'> = {
  fatal: 'critical',
  error: 'high',
  warning: 'med',
  info: 'low',
  debug: 'low',
};

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type Normalised = {
  sentryIssueId: string;
  title: string;
  level: SentryLevel;
  url: string;
  eventCount: number;
  transaction: string;
  tenantId: string;
  tenantPlan: string;
  tenantVertical: string;
  userId: string;
  errorBoundary: string | null;
  release: string | null;
  triggeredRule: string | null;
};

/**
 * Collapse the two Sentry payload shapes into one normalised object.
 * Returns null when the payload is missing the bits we need to identify
 * an issue (so the caller can 400 instead of writing junk).
 */
function normalise(payload: SentryWebhookPayload, resource: string | null): Normalised | null {
  // `event_alert` is where the rich tag data lives — prefer it when present.
  const event = payload.data?.event;
  const issue = payload.data?.issue;

  if (resource === 'event_alert' && event) {
    const tags = tagsToObject(event.tags);
    const sentryIssueId = String(event.issue_id ?? event.event_id ?? '');
    if (!sentryIssueId) return null;
    return {
      sentryIssueId,
      title: event.title ?? 'Untitled Sentry event',
      level: (event.level as SentryLevel) ?? 'error',
      url: event.web_url ?? event.url ?? '',
      eventCount: 1, // alert payloads describe a single event; spike rules retrigger
      transaction: event.transaction ?? tags.transaction ?? 'unknown',
      tenantId: tags.tenant_id ?? 'unknown',
      tenantPlan: tags.tenant_plan ?? 'unknown',
      tenantVertical: tags.tenant_vertical ?? 'unknown',
      userId: event.user?.id ?? tags['user.id'] ?? tags.user_id ?? 'unknown',
      errorBoundary: tags.error_boundary ?? null,
      release: event.release ?? tags.release ?? null,
      triggeredRule: payload.data?.triggered_rule ?? null,
    };
  }

  if (issue) {
    return {
      sentryIssueId: String(issue.id),
      title: issue.title ?? 'Untitled Sentry issue',
      level: (issue.level as SentryLevel) ?? 'error',
      url: issue.web_url ?? issue.permalink ?? '',
      eventCount: Number(issue.count ?? 1),
      // Issue-resource fires don't carry an event, so no tags. These show
      // up as 'unknown' in ops; that's expected for issue-state changes.
      transaction: issue.culprit ?? 'unknown',
      tenantId: 'unknown',
      tenantPlan: 'unknown',
      tenantVertical: 'unknown',
      userId: 'unknown',
      errorBoundary: null,
      release: null,
      triggeredRule: null,
    };
  }

  return null;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get('sentry-hook-signature');
  const resourceDbg = req.headers.get('sentry-hook-resource');

  // Temporary diagnostic — first wired Sentry test fires have failed and we
  // need the actual headers/body shape to fix the parser. Strip after.
  console.log('[sentry-webhook] resource=%s sig?=%s body_len=%d body_preview=%s',
    resourceDbg,
    signature ? 'yes' : 'no',
    rawBody.length,
    rawBody.slice(0, 500));

  if (!verifySignature(rawBody, signature, env.sentryWebhookSecret)) {
    console.log('[sentry-webhook] FAIL: invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: SentryWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as SentryWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const resource = req.headers.get('sentry-hook-resource');
  if (resource !== 'issue' && resource !== 'event_alert') {
    return NextResponse.json({ ok: true, ignored: resource });
  }

  const n = normalise(payload, resource);
  if (!n) {
    console.log('[sentry-webhook] FAIL: normalise returned null. action=%s data_keys=%s',
      payload.action, Object.keys(payload.data ?? {}).join(','));
    return NextResponse.json({ error: 'No issue/event in payload' }, { status: 400 });
  }

  const severity = SEVERITY_BY_LEVEL[n.level] ?? 'high';

  const body = [
    `**Route:** ${n.transaction}`,
    `**Tenant:** ${n.tenantId} (${n.tenantPlan} · ${n.tenantVertical})`,
    `**User:** ${n.userId}`,
    n.errorBoundary ? `**Error boundary:** ${n.errorBoundary}` : null,
    n.release ? `**Release:** ${n.release}` : null,
    n.triggeredRule ? `**Triggered rule:** ${n.triggeredRule}` : null,
    `**Event count:** ${n.eventCount}`,
    '',
    `[Open in Sentry](${n.url})`,
  ]
    .filter(Boolean)
    .join('\n');

  const service = createServiceClient();

  const { data, error } = await service
    .schema('ops')
    .from('incidents')
    .upsert(
      {
        actor_type: 'system',
        actor_name: 'sentry-webhook',
        source: 'sentry',
        severity,
        status: 'open',
        title: n.title,
        body,
        sentry_issue_id: n.sentryIssueId,
        sentry_issue_url: n.url,
        event_count: n.eventCount,
        context: {
          level: n.level,
          transaction: n.transaction,
          tenant_id: n.tenantId,
          tenant_plan: n.tenantPlan,
          tenant_vertical: n.tenantVertical,
          user_id: n.userId,
          error_boundary: n.errorBoundary,
          release: n.release,
          triggered_rule: n.triggeredRule,
          sentry_action: payload.action,
          resource,
        },
      },
      { onConflict: 'sentry_issue_id' },
    )
    .select('id, created_at')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    incident_id: data.id,
    sentry_issue_id: n.sentryIssueId,
  });
}

// --- Sentry payload typing ------------------------------------------------

type SentryUser = {
  id?: string;
  email?: string;
  ip_address?: string;
};

type SentryIssue = {
  id: string | number;
  title?: string;
  culprit?: string;
  level?: string;
  web_url?: string;
  permalink?: string;
  count?: string | number;
};

type SentryEvent = {
  event_id?: string;
  issue_id?: string | number;
  title?: string;
  transaction?: string;
  level?: string;
  release?: string;
  tags?: Array<[string, string]>;
  user?: SentryUser;
  web_url?: string;
  url?: string;
};

type SentryWebhookPayload = {
  action?: string;
  data?: {
    issue?: SentryIssue;
    event?: SentryEvent;
    triggered_rule?: string;
  };
};

function tagsToObject(tags: Array<[string, string]> | undefined): Record<string, string> {
  if (!Array.isArray(tags)) return {};
  const out: Record<string, string> = {};
  for (const entry of tags) {
    if (Array.isArray(entry) && entry.length === 2) {
      out[entry[0]] = entry[1];
    }
  }
  return out;
}
