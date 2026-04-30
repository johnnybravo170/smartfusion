'use client';

/**
 * Dual-link navigation row for detail pages (invoice / quote / job /
 * contact / etc.).
 *
 * Solves the rabbit-hole pattern that hard-coded "Back to invoices"
 * caused: the operator opens a project, drills into an invoice, hits
 * Back, and gets dumped onto the global /invoices page — far away from
 * the project they were working on. Two links, side by side:
 *
 *   ← Back to {fromLabel}                    All {homeLabel} →
 *   (smart, may hide)                        (always visible)
 *
 * Smart-back resolution order:
 *   1. `?from=` query param from the URL — explicit, server-renderable,
 *      label comes from `?fromLabel=` (caller threads both via
 *      `withFrom()` from `@/lib/nav/from-link`).
 *   2. `router.back()` if the page was reached via in-app navigation
 *      (same-origin referrer). Generic "← Back" label.
 *   3. Hidden. No `?from`, no internal history → don't lie about what
 *      Back means. Operator falls through to the home link.
 *
 * The home link is the always-on escape hatch — even if smart-back
 * guesses wrong, the operator can always reach the global list.
 */

import { ArrowLeft, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

type Props = {
  /** Home / list-view destination for this entity (e.g. `/invoices`). */
  homeHref: string;
  /** Label for the home link, e.g. `"All invoices"`. */
  homeLabel: string;
};

export function DetailPageNav({ homeHref, homeLabel }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const fromHref = params.get('from');
  const fromLabel = params.get('fromLabel');
  const [hasInternalHistory, setHasInternalHistory] = useState(false);

  useEffect(() => {
    // Same-origin referrer is the reliable signal that we got here
    // from somewhere inside the app. `history.length` lies — Safari
    // pads it, fresh tabs read 1 even after several pushes. Empty
    // referrer / cross-origin referrer both mean "Back" would surprise.
    try {
      const ref = document.referrer;
      if (!ref) return;
      const refUrl = new URL(ref);
      if (refUrl.origin === window.location.origin) {
        setHasInternalHistory(true);
      }
    } catch {
      // ignore — leave hasInternalHistory false
    }
  }, []);

  const showSmartBack = Boolean(fromHref) || hasInternalHistory;
  const smartBackText = fromLabel ? `Back to ${fromLabel}` : 'Back';

  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      {showSmartBack ? (
        fromHref ? (
          <Link
            href={fromHref}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {smartBackText}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {smartBackText}
          </button>
        )
      ) : (
        <span aria-hidden />
      )}
      <Link
        href={homeHref}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        {homeLabel}
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}
