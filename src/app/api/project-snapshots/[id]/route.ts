import { NextResponse } from 'next/server';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

/**
 * Serves a single `project_scope_snapshots` row to the Versions
 * dropdown's read-only viewer modal. Tenant-scoped via the RLS-aware
 * server client.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await getCurrentTenant();
  if (!tenant) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_scope_snapshots')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });

  return NextResponse.json(data);
}
