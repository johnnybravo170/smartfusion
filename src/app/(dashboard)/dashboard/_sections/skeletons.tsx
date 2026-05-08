import { Skeleton } from '@/components/ui/skeleton';

export function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  const keys = Array.from({ length: rows }, (_, i) => `row-${i}`);
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <Skeleton className="h-5 w-40" />
      {keys.map((key) => (
        <Skeleton key={key} className="h-4 w-full" />
      ))}
    </div>
  );
}

export function AttentionSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <SectionSkeleton rows={4} />
      <SectionSkeleton rows={2} />
    </div>
  );
}

export function JobsSkeleton() {
  return <SectionSkeleton rows={3} />;
}

export function PipelineSkeleton() {
  return <SectionSkeleton rows={2} />;
}

export function MetricsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <SectionSkeleton rows={3} />
      <SectionSkeleton rows={2} />
      <SectionSkeleton rows={4} />
    </div>
  );
}
