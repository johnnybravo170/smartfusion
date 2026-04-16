/**
 * Photo upload preview page — dev-only.
 *
 * This page exists so Jonathan can exercise the photo upload + gallery
 * components end-to-end before Phase 1C wires them into `/jobs/[id]`.
 * There is intentionally no sidebar link; the page is reachable only by
 * typing `/photos-demo` in the URL bar. Once Phase 1C ships, this route
 * (and the JobPicker component) are removed.
 *
 * Spec: PHASE_1_PLAN.md §8 Track D §8.
 */

import { JobPicker } from '@/components/features/photos/job-picker';
import { PhotoGallery } from '@/components/features/photos/photo-gallery';
import { PhotoUpload } from '@/components/features/photos/photo-upload';
import { listJobs } from '@/lib/db/queries/jobs';

type RawSearchParams = Record<string, string | string[] | undefined>;

function parseJobId(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export const metadata = {
  title: 'Photos preview — Smartfusion',
};

export default async function PhotosDemoPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const selectedJobId = parseJobId(sp.job_id);

  const jobs = await listJobs({ limit: 500 });

  const jobOptions = jobs.map((j) => ({
    id: j.id,
    label: j.customer?.name
      ? `${j.customer.name} · ${j.status}`
      : `Job ${j.id.slice(0, 8)} · ${j.status}`,
  }));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Photos (preview)</h1>
        <p className="text-sm text-muted-foreground">
          Upload photos to any of your jobs. This page is a preview — photo management will live on
          the job detail page itself once integrated.
        </p>
      </header>

      <JobPicker jobs={jobOptions} selected={selectedJobId} />

      {selectedJobId ? (
        <div className="flex flex-col gap-5">
          <PhotoUpload jobId={selectedJobId} />
          <PhotoGallery jobId={selectedJobId} />
        </div>
      ) : (
        <div
          className="rounded-xl border border-dashed bg-card p-6 text-sm"
          data-slot="demo-empty-state"
        >
          <p className="font-medium">Pick a job to start uploading photos.</p>
          <p className="mt-1 text-muted-foreground">
            Need one?{' '}
            <a href="/jobs/new" className="text-foreground underline">
              Schedule a job
            </a>{' '}
            and come back.
          </p>
        </div>
      )}
    </div>
  );
}
