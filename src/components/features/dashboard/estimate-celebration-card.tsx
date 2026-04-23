'use client';

/**
 * Green dismissible card shown at the top of the dashboard the first
 * time a customer views one of this operator's estimates. Persists
 * across refreshes until the operator clicks dismiss or a newer
 * first-view event arrives (older acknowledged event → drops off).
 */

import { PartyPopper, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { EstimateCelebration } from '@/lib/db/queries/estimate-celebrations';
import { acknowledgeEstimateCelebrationAction } from '@/server/actions/estimate-celebrations';

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function EstimateCelebrationCard({ celebration }: { celebration: EstimateCelebration }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleDismiss() {
    startTransition(async () => {
      const result = await acknowledgeEstimateCelebrationAction({
        projectId: celebration.projectId,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  const who = celebration.customerName ?? 'A customer';

  return (
    <div className="flex items-start gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/40">
      <div className="flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <PartyPopper className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-emerald-950 dark:text-emerald-100">
          {who} just opened your estimate
        </p>
        <p className="mt-0.5 text-sm text-emerald-800 dark:text-emerald-300">
          <Link
            href={`/projects/${celebration.projectId}?tab=estimate`}
            className="underline underline-offset-2 hover:no-underline"
          >
            {celebration.projectName}
          </Link>{' '}
          · {relativeTime(celebration.viewedAt)}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDismiss}
        disabled={pending}
        aria-label="Dismiss"
        className="text-emerald-800 hover:bg-emerald-100 hover:text-emerald-900 dark:text-emerald-200 dark:hover:bg-emerald-900/60"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
