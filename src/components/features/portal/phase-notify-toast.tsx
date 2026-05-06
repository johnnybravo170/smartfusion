'use client';

/**
 * Live countdown toast for the deferred phase-advance notification.
 *
 * After the operator clicks Advance, the notification is scheduled
 * server-side ~5 minutes out. This toast keeps the operator aware of
 * the pending send and offers an Undo: hitting Undo cancels the
 * notification. A subsequent advance dismisses any prior toast and
 * shows a new one for the new phase ("replace" semantic).
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cancelPhaseNotifyAction } from '@/server/actions/project-phases';

let activeToastId: string | number | null = null;

export function showPhaseNotifyToast(params: {
  projectId: string;
  phaseName: string;
  scheduledAt: string;
}): void {
  // Replace any prior pending toast so a rapid second advance doesn't
  // stack toasts. The Undo on the prior one is no longer meaningful —
  // the prior notify was server-side cancelled by the new advance.
  if (activeToastId !== null) {
    toast.dismiss(activeToastId);
  }

  const id = toast.custom(
    (toastId) => (
      <PhaseNotifyToastContent
        toastId={toastId}
        projectId={params.projectId}
        phaseName={params.phaseName}
        scheduledAt={params.scheduledAt}
      />
    ),
    { duration: Infinity },
  );
  activeToastId = id;
}

function PhaseNotifyToastContent({
  toastId,
  projectId,
  phaseName,
  scheduledAt,
}: {
  toastId: string | number;
  projectId: string;
  phaseName: string;
  scheduledAt: string;
}) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.round((new Date(scheduledAt).getTime() - Date.now()) / 1000)),
  );
  const [cancelled, setCancelled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cancelled) return;
    const target = new Date(scheduledAt).getTime();
    const tick = () => {
      const left = Math.max(0, Math.round((target - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) {
        // Self-dismiss shortly after hitting zero — the cron drainer
        // sends within ~60s of this point. The toast has done its job.
        setTimeout(() => {
          toast.dismiss(toastId);
          if (activeToastId === toastId) activeToastId = null;
        }, 1500);
      }
    };
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [scheduledAt, toastId, cancelled]);

  async function onUndo() {
    setBusy(true);
    const res = await cancelPhaseNotifyAction(projectId);
    setBusy(false);
    if (res.ok) {
      setCancelled(true);
      setTimeout(() => {
        toast.dismiss(toastId);
        if (activeToastId === toastId) activeToastId = null;
      }, 1500);
    } else {
      toast.error(res.error);
    }
  }

  const mm = Math.floor(secondsLeft / 60);
  const ss = (secondsLeft % 60).toString().padStart(2, '0');

  return (
    <div className="flex w-[360px] items-center justify-between gap-3 rounded-md border bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1">
        {cancelled ? (
          <>
            <p className="text-sm font-medium">Notification cancelled</p>
            <p className="truncate text-xs text-muted-foreground">
              No message will be sent about {phaseName}.
            </p>
          </>
        ) : secondsLeft > 0 ? (
          <>
            <p className="text-sm font-medium">
              Notifying customer in{' '}
              <span className="tabular-nums">
                {mm}:{ss}
              </span>
            </p>
            <p className="truncate text-xs text-muted-foreground">About: {phaseName}</p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">Notification sending…</p>
            <p className="truncate text-xs text-muted-foreground">About: {phaseName}</p>
          </>
        )}
      </div>
      {!cancelled && secondsLeft > 0 ? (
        <Button type="button" size="sm" variant="outline" onClick={onUndo} disabled={busy}>
          Undo
        </Button>
      ) : null}
    </div>
  );
}
