/**
 * Customer-side inbound email router.
 *
 * Phase 2 of PROJECT_MESSAGING_PLAN.md. Resolves a customer's reply to
 * an exact (tenant_id, project_id) tuple. Three tiers:
 *
 *   1. In-Reply-To / References header → project_messages.external_id
 *      (primary, robust across tenants because Message-IDs are globally
 *      unique).
 *   2. Body footer token `[Ref: P-xxxxxx]` → projectRefMatches against
 *      candidate projects (redundant fallback for header mangling).
 *   3. Recency-within-tenant: among candidates, exactly one with
 *      outbound to this customer in the last 30 days wins. Else null.
 *
 * On null, the caller bounces. Privacy guarantee: never surface a
 * reply to the wrong tenant — bounce on ambiguity.
 */

import { parseProjectRefFromBody, projectRefMatches } from '@/lib/messaging/project-ref';
import { createAdminClient } from '@/lib/supabase/admin';

export type CustomerCandidate = {
  customerId: string;
  tenantId: string;
  projectId: string;
};

export type ResolvedProject = {
  tenantId: string;
  projectId: string;
  customerId: string;
  /** The matching outbound row, when resolved via In-Reply-To. */
  inReplyToMessageId: string | null;
};

/**
 * List every (tenant, project, customer) where this email is on a
 * non-deleted active project. Excludes archived projects (lifecycle =
 * 'cancelled' or 'complete' beyond a recency window).
 */
export async function listCustomerCandidatesForEmail(email: string): Promise<CustomerCandidate[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('customers')
    .select('id, tenant_id, projects:projects!projects_customer_id_fkey (id, lifecycle_stage)')
    .ilike('email', email)
    .is('deleted_at', null);

  if (error || !data) return [];

  const out: CustomerCandidate[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    const tenantId = row.tenant_id as string;
    const customerId = row.id as string;
    const projects = (row.projects as Array<Record<string, unknown>> | null) ?? [];
    for (const p of projects) {
      const stage = p.lifecycle_stage as string;
      if (stage === 'cancelled') continue;
      out.push({
        customerId,
        tenantId,
        projectId: p.id as string,
      });
    }
  }
  return out;
}

/**
 * Parse Message-IDs out of an In-Reply-To or References header value.
 * Headers can contain multiple angle-bracketed ids separated by
 * whitespace or commas; we want all of them.
 */
function parseMessageIds(headerValue: string | null | undefined): string[] {
  if (!headerValue) return [];
  const matches = headerValue.match(/<[^>]+>/g);
  return matches ?? [];
}

export async function resolveProjectForCustomerReply(args: {
  fromEmail: string;
  bodyText: string | null;
  bodyHtml: string | null;
  inReplyToHeader: string | null;
  referencesHeader: string | null;
}): Promise<ResolvedProject | null> {
  const candidates = await listCustomerCandidatesForEmail(args.fromEmail);
  if (candidates.length === 0) return null;

  const admin = createAdminClient();

  // Tier 1 — In-Reply-To / References header match.
  const ids = [...parseMessageIds(args.inReplyToHeader), ...parseMessageIds(args.referencesHeader)];
  if (ids.length > 0) {
    const { data: matches } = await admin
      .from('project_messages')
      .select('id, tenant_id, project_id, external_id')
      .in('external_id', ids)
      .limit(5);

    for (const m of (matches ?? []) as Array<Record<string, unknown>>) {
      const tenantId = m.tenant_id as string;
      const projectId = m.project_id as string;
      // Only honor the match if this customer is actually on that project —
      // prevents header-spoof attacks from cross-tenant routing.
      const ok = candidates.some((c) => c.tenantId === tenantId && c.projectId === projectId);
      if (ok) {
        const customer = candidates.find(
          (c) => c.tenantId === tenantId && c.projectId === projectId,
        );
        return {
          tenantId,
          projectId,
          customerId: customer?.customerId ?? '',
          inReplyToMessageId: m.external_id as string,
        };
      }
    }
  }

  // Tier 2 — body footer token.
  const bodyForToken = `${args.bodyText ?? ''}\n${stripHtml(args.bodyHtml)}`;
  const tokenCandidate = parseProjectRefFromBody(bodyForToken);
  if (tokenCandidate) {
    for (const c of candidates) {
      if (projectRefMatches(c.projectId, tokenCandidate)) {
        return {
          tenantId: c.tenantId,
          projectId: c.projectId,
          customerId: c.customerId,
          inReplyToMessageId: null,
        };
      }
    }
  }

  // Tier 3 — recency-within-tenant. If exactly one candidate has
  // outbound to this email in the last 30 days, use it.
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recents: CustomerCandidate[] = [];
  for (const c of candidates) {
    const { count } = await admin
      .from('email_send_log')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', c.tenantId)
      .ilike('to_address', `%${args.fromEmail}%`)
      .gte('sent_at', sinceIso);
    if ((count ?? 0) > 0) recents.push(c);
  }
  if (recents.length === 1) {
    return {
      tenantId: recents[0].tenantId,
      projectId: recents[0].projectId,
      customerId: recents[0].customerId,
      inReplyToMessageId: null,
    };
  }

  // Bounce: zero, ambiguous, or unmatched.
  return null;
}

function stripHtml(html: string | null): string {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
}
