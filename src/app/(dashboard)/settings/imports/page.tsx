import { redirect } from 'next/navigation';
import { type ImportBatchRow, ImportsList } from '@/components/features/onboarding/imports-list';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Imports — HeyHenry',
};

export default async function ImportsSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/settings/imports');

  const supabase = await createClient();
  const { data: batches, error } = await supabase
    .from('import_batches')
    .select(
      'id, kind, source_filename, summary, note, created_at, rolled_back_at, created_by, rolled_back_by',
    )
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);

  // Resolve created_by / rolled_back_by user emails for the row label.
  // Done via the admin client because auth.users isn't readable through
  // RLS — same approach the team page uses.
  const userIds = Array.from(
    new Set(
      (batches ?? [])
        .flatMap((b) => [b.created_by as string | null, b.rolled_back_by as string | null])
        .filter((u): u is string => !!u),
    ),
  );
  const emailByUserId = new Map<string, string>();
  if (userIds.length > 0) {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const admin = createAdminClient();
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of users?.users ?? []) {
      if (u.id && u.email) emailByUserId.set(u.id, u.email);
    }
  }

  const rows: ImportBatchRow[] = (batches ?? []).map((b) => ({
    id: b.id as string,
    kind: b.kind as 'customers' | 'projects' | 'invoices' | 'expenses',
    sourceFilename: (b.source_filename as string | null) ?? null,
    summary: (b.summary as { created?: number; merged?: number; skipped?: number }) ?? {},
    note: (b.note as string | null) ?? null,
    createdAt: b.created_at as string,
    createdByEmail: b.created_by ? (emailByUserId.get(b.created_by as string) ?? null) : null,
    rolledBackAt: (b.rolled_back_at as string | null) ?? null,
    rolledBackByEmail: b.rolled_back_by
      ? (emailByUserId.get(b.rolled_back_by as string) ?? null)
      : null,
  }));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <DetailPageNav homeHref="/settings" homeLabel="All settings" />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Imports</h1>
        <p className="text-sm text-muted-foreground">
          Every batch of data Henry has brought into your account, newest first. Roll one back if it
          went wrong — the records get soft-deleted, your existing customers stay put.
        </p>
      </header>
      <ImportsList batches={rows} timezone={tenant.timezone} />
    </div>
  );
}
