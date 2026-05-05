import { type NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import { createSessionInputSchema } from '@/lib/board/types';
import { createSession, listSessions } from '@/server/ops-services/board';

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req, { requiredScope: 'read:board' });
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);

  let sessions: Awaited<ReturnType<typeof listSessions>>;
  try {
    sessions = await listSessions(limit);
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
  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req, { requiredScope: 'write:board' });
  if (!auth.ok) return auth.response;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = createSessionInputSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    session = await createSession(parsed.data, { admin_user_id: null, key_id: auth.key.id });
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
  return NextResponse.json({ session }, { status: 201 });
}
