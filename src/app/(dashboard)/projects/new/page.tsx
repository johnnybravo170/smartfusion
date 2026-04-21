import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { QuoteImportFlow } from '@/components/features/projects/quote-import-flow';

export const metadata = {
  title: 'New project — HeyHenry',
};

export default function NewProjectPage() {
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
      </div>

      <QuoteImportFlow manualFallbackHref="/projects/new/manual" />
    </div>
  );
}
