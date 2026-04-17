'use client';

const TOOL_LABELS: Record<string, string> = {
  list_jobs: 'Checking your jobs',
  get_customer: 'Looking up customer details',
  get_dashboard: 'Pulling your dashboard',
  create_todo: 'Adding that to your list',
  update_job_status: 'Updating job status',
  search_worklog: 'Searching your work log',
  get_revenue_summary: 'Crunching your numbers',
};

export function ChatToolIndicator({ toolName }: { toolName: string }) {
  const label = TOOL_LABELS[toolName] ?? 'Looking that up';

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground">
      <span className="inline-flex gap-0.5">
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
      </span>
      <span>{label}...</span>
    </div>
  );
}
