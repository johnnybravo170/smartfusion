import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { LeadIntakeForm } from '@/components/features/leads/lead-intake-form';

export const metadata = {
  title: 'New lead from text — HeyHenry',
};

export default function NewLeadPage() {
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
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New project from intake</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop screenshots, reference photos, sketches, PDFs (sub-trade quotes, drawings) — anything
          you have. Henry will extract scope, build a starting estimate, and draft a reply you can
          send back.
        </p>
      </div>

      <LeadIntakeForm />
    </div>
  );
}
