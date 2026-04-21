import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { ProjectForm } from '@/components/features/projects/project-form';
import { listCustomers } from '@/lib/db/queries/customers';
import { createProjectAction } from '@/server/actions/projects';

export const metadata = {
  title: 'New project (manual) — HeyHenry',
};

export default async function NewProjectManualPage() {
  const customers = await listCustomers({ limit: 500 });

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="mb-6">
        <Link
          href="/projects/new"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New project</h1>
        <p className="mt-1 text-sm text-muted-foreground">Enter project details manually.</p>
      </div>

      <ProjectForm
        mode="create"
        customers={customers.map((c) => ({ id: c.id, name: c.name }))}
        action={createProjectAction}
      />
    </div>
  );
}
