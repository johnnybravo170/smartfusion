'use client';

/**
 * Mobile-first task list for the /w worker surface. Each row shows the
 * job + address (tap → map), the task title / due / notes / photos flag,
 * and four big-tap action buttons: Done, Blocked, Need Help, Add Photo.
 *
 * Status changes route through `workerChangeTaskStatusAction` which
 * whitelists the allowed set (in_progress, done, blocked) and requires
 * a blocker reason when moving to blocked.
 *
 * Photo upload isn't yet task-aware — the button links into the job's
 * photo surface. TODO(phase-4): tie uploaded photos to task_id so the
 * required-photo gate can be enforced at verify time.
 */

import { Camera, CheckCircle2, HandHelping, MapPin, OctagonAlert } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { WorkerTaskRow } from '@/lib/db/queries/tasks';
import { cn } from '@/lib/utils';
import { taskStatusLabels } from '@/lib/validators/task';
import { workerChangeTaskStatusAction, workerNeedHelpAction } from '@/server/actions/tasks';

function mapUrl(addr: string | null): string | null {
  if (!addr) return null;
  return `https://maps.google.com/?q=${encodeURIComponent(addr)}`;
}

function formatDue(due: string | null): string | null {
  if (!due) return null;
  const [y, m, d] = due.split('-').map(Number);
  if (!y || !m || !d) return due;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function WorkerTaskList({ tasks }: { tasks: WorkerTaskRow[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {tasks.map((t) => (
        <li key={t.id}>
          <WorkerTaskCard task={t} />
        </li>
      ))}
    </ul>
  );
}

function WorkerTaskCard({ task }: { task: WorkerTaskRow }) {
  const [pending, startTransition] = useTransition();
  const [blockerOpen, setBlockerOpen] = useState(false);
  const [blockerText, setBlockerText] = useState('');

  function run(status: 'in_progress' | 'done' | 'blocked', blockerReason?: string) {
    startTransition(async () => {
      const res = await workerChangeTaskStatusAction({
        id: task.id,
        status,
        blocker_reason: blockerReason,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Marked ${taskStatusLabels[status]}.`);
      if (status === 'blocked') {
        setBlockerOpen(false);
        setBlockerText('');
      }
    });
  }

  function onNeedHelp() {
    startTransition(async () => {
      const res = await workerNeedHelpAction({ id: task.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Your PM was notified.');
    });
  }

  const due = formatDue(task.due_date);
  const map = mapUrl(task.job_customer_address);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm',
        pending && 'opacity-60',
      )}
    >
      {/* Job + address */}
      <div className="flex flex-col gap-0.5">
        {task.job_customer_name ? (
          <p className="text-sm font-medium">{task.job_customer_name}</p>
        ) : null}
        {task.job_customer_address ? (
          map ? (
            <a
              href={map}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <MapPin className="size-3.5" aria-hidden />
              {task.job_customer_address}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="size-3.5" aria-hidden />
              {task.job_customer_address}
            </span>
          )
        ) : null}
      </div>

      {/* Title + due */}
      <div>
        <p className="text-base font-semibold leading-tight">{task.title}</p>
        {due ? <p className="mt-0.5 text-xs text-muted-foreground">Due {due}</p> : null}
      </div>

      {/* Notes / instructions */}
      {task.description ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.description}</p>
      ) : null}

      {/* Required photos flag */}
      {task.required_photos ? (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
          Photos required before marking done.
        </p>
      ) : null}

      {/* Blocker reason prompt */}
      {blockerOpen ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed bg-muted/40 p-3">
          <label className="text-xs font-medium" htmlFor={`blocker-${task.id}`}>
            What&apos;s blocking this?
          </label>
          <Textarea
            id={`blocker-${task.id}`}
            value={blockerText}
            onChange={(e) => setBlockerText(e.target.value)}
            placeholder="Waiting on permit, sub no-show, damaged material…"
            rows={3}
            className="text-sm"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setBlockerOpen(false);
                setBlockerText('');
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => run('blocked', blockerText)}
              disabled={pending || blockerText.trim().length < 5}
            >
              Mark blocked
            </Button>
          </div>
        </div>
      ) : null}

      {/* Action buttons — 4 big tap targets */}
      <div className="grid grid-cols-2 gap-2">
        <ActionButton
          label="Done"
          icon={CheckCircle2}
          tone="emerald"
          onClick={() => run('done')}
          disabled={pending}
        />
        <ActionButton
          label="Blocked"
          icon={OctagonAlert}
          tone="red"
          onClick={() => setBlockerOpen((v) => !v)}
          disabled={pending}
        />
        <ActionButton
          label="Need help"
          icon={HandHelping}
          tone="amber"
          onClick={onNeedHelp}
          disabled={pending}
        />
        {task.job_id ? (
          <Link
            href={`/jobs/${task.job_id}`}
            className="flex h-16 flex-col items-center justify-center gap-1 rounded-md border bg-background text-xs font-medium"
          >
            <Camera className="size-5" aria-hidden />
            Add photo
          </Link>
        ) : (
          <ActionButton
            label="Add photo"
            icon={Camera}
            tone="neutral"
            onClick={() =>
              toast.info('Photo upload is on the job page. Coming to this screen soon.')
            }
            disabled={pending}
          />
        )}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  icon: Icon,
  tone,
  onClick,
  disabled,
}: {
  label: string;
  icon: typeof CheckCircle2;
  tone: 'emerald' | 'red' | 'amber' | 'neutral';
  onClick: () => void;
  disabled?: boolean;
}) {
  const toneClass = {
    emerald: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/60',
    red: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/60',
    amber: 'bg-amber-500 text-white hover:bg-amber-600 disabled:bg-amber-500/60',
    neutral: 'bg-background text-foreground border hover:bg-accent',
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-16 flex-col items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors',
        toneClass,
      )}
    >
      <Icon className="size-5" aria-hidden />
      {label}
    </button>
  );
}
