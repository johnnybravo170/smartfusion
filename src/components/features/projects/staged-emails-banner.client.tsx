'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type Item = {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  classification: string;
};

const CLASSIFY_LABEL: Record<string, string> = {
  sub_quote: 'Vendor Quote',
  vendor_bill: 'Vendor Bill',
  other: 'Other',
};

/**
 * Dismiss state lives in localStorage keyed by project + most-recent
 * received_at. A new forward bumps the key, so dismissed banners
 * automatically re-appear on the next forward.
 */
export function StagedEmailsBannerClient({
  projectId,
  total,
  items,
  dismissKey,
  children,
}: {
  projectId: string;
  total: number;
  items: Item[];
  dismissKey: string;
  children: React.ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);

  // Read on mount so SSR shows the banner; effect collapses it if
  // already dismissed for this dismissKey.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(dismissKey) === '1') {
        setDismissed(true);
      }
    } catch {
      // ignore — Safari private mode etc
    }
  }, [dismissKey]);

  if (dismissed) return null;

  function handleDismiss() {
    try {
      window.localStorage.setItem(dismissKey, '1');
    } catch {
      // ignore
    }
    setDismissed(true);
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">{children}</div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground"
          onClick={handleDismiss}
          aria-label="Dismiss"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {items.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-amber-200 pt-2 dark:border-amber-800">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate">
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium dark:bg-amber-900">
                  {CLASSIFY_LABEL[it.classification] ?? it.classification}
                </span>{' '}
                <span className="font-medium">{it.subject}</span>
                <span className="text-muted-foreground"> — {it.from}</span>
              </span>
              <Link
                href={`/inbox/intake?source=email&project=${projectId}`}
                className="shrink-0 underline hover:no-underline"
              >
                Review
              </Link>
            </li>
          ))}
          {total > items.length && (
            <li className="text-xs text-muted-foreground">+ {total - items.length} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
