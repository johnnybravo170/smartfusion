'use client';

/**
 * Operator-facing card that surfaces customer comments on a pending
 * estimate. Unseen rows get a chip + "Mark as seen" button.
 */

import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { markEstimateFeedbackSeenAction } from '@/server/actions/estimate-approval';

export type FeedbackRow = {
  id: string;
  body: string;
  cost_line_id: string | null;
  cost_line_label: string | null;
  seen_at: string | null;
  created_at: string;
};

export function EstimateFeedbackCard({
  projectId,
  feedback,
}: {
  projectId: string;
  feedback: FeedbackRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (feedback.length === 0) return null;

  const unseenIds = feedback.filter((f) => !f.seen_at).map((f) => f.id);

  function markAllSeen() {
    startTransition(async () => {
      const res = await markEstimateFeedbackSeenAction({ projectId, commentIds: unseenIds });
      if (res.ok) {
        toast.success('Marked as seen');
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <section id="feedback" className="mb-6 rounded-lg border border-blue-200 bg-blue-50/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-blue-900">
          Customer feedback
          {unseenIds.length > 0 ? (
            <span className="ml-2 inline-flex items-center rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
              {unseenIds.length} new
            </span>
          ) : null}
        </h3>
        {unseenIds.length > 0 ? (
          <Button size="sm" variant="outline" onClick={markAllSeen} disabled={pending}>
            <Check className="size-3.5" />
            Mark all seen
          </Button>
        ) : null}
      </div>
      <ul className="space-y-2">
        {feedback.map((f) => (
          <li
            key={f.id}
            className={`rounded-md border bg-white p-3 text-sm ${
              f.seen_at ? 'border-muted' : 'border-blue-300'
            }`}
          >
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {f.cost_line_label ? (
                  <span className="font-medium text-foreground">{f.cost_line_label}</span>
                ) : (
                  <span className="italic">General</span>
                )}
              </span>
              <span>{new Date(f.created_at).toLocaleString()}</span>
            </div>
            <p className="whitespace-pre-wrap">{f.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
