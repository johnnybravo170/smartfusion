import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { LeadIntakeForm } from '@/components/features/leads/lead-intake-form';
import { ProjectForm } from '@/components/features/projects/project-form';
import { listCustomers } from '@/lib/db/queries/customers';
import { createProjectAction } from '@/server/actions/projects';

export const metadata = {
  title: 'New project — HeyHenry',
};

// Voice-memo intake may run Whisper transcription inside the server action
// invoked from this page; 60 s keeps big audio drops from timing out.
export const maxDuration = 60;

type RawSearchParams = Record<string, string | string[] | undefined>;

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const customerParam = typeof params.customer === 'string' ? params.customer : null;
  // ?ai=claude swaps the parse model from gpt-4.1 to claude-sonnet-4-5
  // so the same memo can be A/B'd by URL. Anything else (or missing) =
  // default OpenAI path.
  const aiChoice = typeof params.ai === 'string' && params.ai === 'claude' ? 'claude' : 'openai';
  const customers = await listCustomers({ limit: 500 });

  // Valid ?customer=<id> means the operator already picked someone (usually
  // by clicking "Start project" from a lead's detail page). Skip the intake
  // drop zone and open the manual form pre-filled — no point re-identifying
  // a contact we already have.
  const preselectedCustomer =
    customerParam && customers.some((c) => c.id === customerParam) ? customerParam : null;

  if (preselectedCustomer) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-6">
          <Link
            href={`/contacts/${preselectedCustomer}`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to contact
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Start project</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The contact&rsquo;s already selected. Fill in the project details and save — creating
            this project will promote them to a customer automatically.
          </p>
        </div>

        <ProjectForm
          mode="create"
          customers={customers.map((c) => ({ id: c.id, name: c.name }))}
          defaults={{ customer_id: preselectedCustomer }}
          action={createProjectAction}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-6">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to projects
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New project</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop screenshots, photos, sketches, PDFs (sub-trade quotes, drawings) — or paste the
          message. Henry will extract scope, build a starting estimate, and draft a reply.
        </p>
        {aiChoice === 'claude' ? (
          <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
            Parse model: Claude Sonnet (A/B mode)
          </p>
        ) : null}
      </div>

      <LeadIntakeForm parseModel={aiChoice === 'claude' ? 'claude-sonnet' : 'gpt-4.1'} />

      <details className="mt-8 rounded-lg border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Or enter manually (existing customer, no artifacts)
        </summary>
        <div className="mt-4">
          <ProjectForm
            mode="create"
            customers={customers.map((c) => ({ id: c.id, name: c.name }))}
            action={createProjectAction}
          />
        </div>
      </details>
    </div>
  );
}
