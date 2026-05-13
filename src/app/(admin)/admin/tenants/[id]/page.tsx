import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TenantDetail } from '@/components/features/admin/tenant-detail';
import { getTenantDetail } from '@/lib/db/queries/admin';

type Props = {
  params: Promise<{ id: string }>;
};

export default async function AdminTenantDetailPage({ params }: Props) {
  const { id } = await params;
  const tenant = await getTenantDetail(id);

  if (!tenant) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Link href="/admin" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; All operators
        </Link>
      </div>

      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{tenant.name}</h1>
          <p className="text-sm text-muted-foreground">
            Read-only support view of this operator&apos;s account.
          </p>
        </div>
        <Link
          href={`/admin/tenants/${id}/audit`}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Audit log &rarr;
        </Link>
      </div>

      <TenantDetail tenant={tenant} />
    </div>
  );
}
