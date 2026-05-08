'use client';

/**
 * Empty-state bootstrap panel for the Schedule tab.
 *
 * Three big-button choice — Apply template / Build from budget /
 * Start blank — per the Gantt v0 spec. The "Apply template" button
 * opens a sub-modal listing the seeded project_type_templates so the
 * GC picks which one (Kitchen Reno / Bath Reno / Basement Finish /
 * Addition).
 *
 * Calls bootstrapProjectScheduleAction; on success the page revalidates
 * server-side and the operator sees the populated Gantt.
 */

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ScheduleTaskEditor } from '@/components/features/projects/schedule-task-editor';
import { Button } from '@/components/ui/button';
import {
  type BootstrapSource,
  bootstrapProjectScheduleAction,
} from '@/server/actions/project-schedule';

export type ProjectTypeTemplateOption = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tradeCount: number;
};

export function ScheduleBootstrapPanel({
  projectId,
  templates,
}: {
  projectId: string;
  templates: ProjectTypeTemplateOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [blankCreatorOpen, setBlankCreatorOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track which source the operator picked so the loading overlay can
  // tell them what they're waiting for. Budget mode may invoke AI
  // (3-5s); template/blank are fast.
  const [pendingSource, setPendingSource] = useState<BootstrapSource['kind'] | null>(null);

  const run = (source: BootstrapSource) => {
    setError(null);
    setPendingSource(source.kind);
    startTransition(async () => {
      const res = await bootstrapProjectScheduleAction(projectId, source);
      if (!res.ok) {
        setError(res.error);
        setPendingSource(null);
        return;
      }
      setPickerOpen(false);
      router.refresh();
    });
  };

  const loadingCopy =
    pendingSource === 'budget'
      ? 'Generating your schedule…'
      : pendingSource === 'template'
        ? 'Applying template…'
        : 'Setting up…';

  if (pending) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border bg-card p-12 text-center">
        <Loader2 className="size-8 animate-spin text-primary" />
        <p className="mt-4 text-sm font-medium">{loadingCopy}</p>
        {pendingSource === 'budget' ? (
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            We&rsquo;re reading your budget categories and laying out a draft order. This usually
            takes 3–5 seconds.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-8">
      <h2 className="text-lg font-semibold">No schedule yet</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick a starting point. You can drag and edit anything afterwards — this just gets you a
        rough draft to share with the customer.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={pending}
          className="flex h-32 flex-col items-start justify-between rounded-md border bg-background p-4 text-left transition hover:border-primary hover:bg-primary/5 disabled:opacity-50"
        >
          <span className="text-sm font-semibold">Apply template</span>
          <span className="text-xs text-muted-foreground">
            Pick a project type — Kitchen Reno, Bath Reno, etc.
          </span>
        </button>

        <button
          type="button"
          onClick={() => run({ kind: 'budget' })}
          disabled={pending}
          className="flex h-32 flex-col items-start justify-between rounded-md border bg-background p-4 text-left transition hover:border-primary hover:bg-primary/5 disabled:opacity-50"
        >
          <span className="text-sm font-semibold">Build from your budget</span>
          <span className="text-xs text-muted-foreground">
            Use the trades already in your budget categories.
          </span>
        </button>

        <button
          type="button"
          onClick={() => setBlankCreatorOpen(true)}
          disabled={pending}
          className="flex h-32 flex-col items-start justify-between rounded-md border bg-background p-4 text-left transition hover:border-primary hover:bg-primary/5 disabled:opacity-50"
        >
          <span className="text-sm font-semibold">Start blank</span>
          <span className="text-xs text-muted-foreground">
            Add tasks one at a time. Opens the new-task editor below.
          </span>
        </button>
      </div>

      {blankCreatorOpen ? (
        <ScheduleTaskEditor
          mode={{
            kind: 'create',
            projectId,
            defaultStartDate: new Date().toISOString().slice(0, 10),
          }}
          // Empty-state has no existing tasks, so the picker has nothing
          // to choose from — gets hidden by candidatePredecessors check.
          allTasks={[]}
          initialPredecessorIds={[]}
          open={true}
          onClose={() => setBlankCreatorOpen(false)}
        />
      ) : null}

      {error ? (
        <p className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {pickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          {/* Backdrop click-to-close uses a button overlay so a11y rules
              don't fight us; the actual dialog content sits above it. */}
          <button
            type="button"
            aria-label="Close template picker"
            className="absolute inset-0 cursor-default"
            onClick={() => setPickerOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="template-picker-title"
            className="relative w-full max-w-2xl rounded-lg border bg-background p-6 shadow-lg"
          >
            <h3 id="template-picker-title" className="text-base font-semibold">
              Pick a project type
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              We&rsquo;ll lay out a rough schedule from this template — you can adjust anything
              after.
            </p>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => run({ kind: 'template', projectTypeTemplateSlug: tpl.slug })}
                  disabled={pending}
                  className="flex flex-col items-start rounded-md border bg-card p-3 text-left transition hover:border-primary hover:bg-primary/5 disabled:opacity-50"
                >
                  <span className="text-sm font-semibold">{tpl.name}</span>
                  {tpl.description ? (
                    <span className="mt-1 text-xs text-muted-foreground">{tpl.description}</span>
                  ) : null}
                  <span className="mt-2 text-[11px] text-muted-foreground">
                    {tpl.tradeCount} {tpl.tradeCount === 1 ? 'trade' : 'trades'}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPickerOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
