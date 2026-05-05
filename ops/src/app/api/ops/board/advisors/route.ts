import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import { createAdvisor, listAdvisors } from '@/server/ops-services/board';

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req, { requiredScope: 'read:board' });
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const includeRetired = url.searchParams.get('include_retired') === 'true';

  let advisors: Awaited<ReturnType<typeof listAdvisors>>;
  try {
    advisors = await listAdvisors({ include_retired: includeRetired });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    );
  }

  await logAuditSuccess(
    auth.key.id,
    'GET',
    url.pathname + url.search,
    200,
    auth.key.ip,
    req.headers.get('user-agent'),
    auth.bodySha,
    auth.reason,
  );
  return NextResponse.json({ advisors });
}

const createSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(200),
  emoji: z.string().trim().min(1).max(8),
  title: z.string().trim().min(1).max(200),
  role_kind: z.enum(['expert', 'challenger', 'chair']),
  expertise: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  description: z.string().trim().max(4000).default(''),
  knowledge_id: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'retired']).default('active'),
  sort_order: z.number().int().min(0).max(1000).default(0),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req, { requiredScope: 'write:board' });
  if (!auth.ok) return auth.response;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  let advisor: Awaited<ReturnType<typeof createAdvisor>>;
  try {
    advisor = await createAdvisor({
      ...parsed.data,
      knowledge_id: parsed.data.knowledge_id ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  await logAuditSuccess(
    auth.key.id,
    'POST',
    url.pathname + url.search,
    201,
    auth.key.ip,
    req.headers.get('user-agent'),
    auth.bodySha,
    auth.reason,
  );
  return NextResponse.json({ advisor }, { status: 201 });
}
