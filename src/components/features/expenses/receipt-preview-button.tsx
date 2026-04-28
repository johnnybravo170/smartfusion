'use client';

/**
 * Receipt preview on the overhead expenses list.
 *
 * Desktop: hover the paperclip → thumbnail popover. Touch devices don't
 * fire hover so they go straight to click. Either way, click → full-size
 * modal of the receipt.
 *
 * Signed URLs for every row's receipt are generated server-side in one
 * batch in `listOverheadExpenses`, so this component is zero-fetch.
 */

import { FileText, Paperclip } from 'lucide-react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';

type Props = {
  url: string | null;
  mimeHint: 'image' | 'pdf' | null;
  vendor: string | null;
};

export function ReceiptPreviewButton({ url, mimeHint, vendor }: Props) {
  const [open, setOpen] = useState(false);

  if (!url) return null;

  const label = vendor ? `Receipt — ${vendor}` : 'Receipt';
  const isPdf = mimeHint === 'pdf';

  const triggerButton = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setOpen(true);
      }}
      aria-label={label}
      title={label}
      className="text-muted-foreground transition-colors hover:text-foreground"
    >
      {isPdf ? <FileText className="size-3.5" /> : <Paperclip className="size-3.5" />}
    </button>
  );

  return (
    <>
      {isPdf ? (
        // Tiny PDF thumbnails are noisy in iframes — skip the hover preview
        // and rely on the click → modal flow.
        triggerButton
      ) : (
        <HoverCard openDelay={150} closeDelay={50}>
          <HoverCardTrigger asChild>{triggerButton}</HoverCardTrigger>
          <HoverCardContent className="w-56 p-1.5">
            {/* biome-ignore lint/performance/noImgElement: signed URL, dynamic per row */}
            <img src={url} alt={label} className="max-h-48 w-full rounded-sm object-contain" />
            <div className="mt-1.5 text-center text-[11px] text-muted-foreground">
              Click to enlarge
            </div>
          </HoverCardContent>
        </HoverCard>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">{label}</DialogTitle>
          </DialogHeader>
          {isPdf ? (
            <iframe src={url} title={label} className="h-[75vh] w-full rounded-sm border" />
          ) : (
            // biome-ignore lint/performance/noImgElement: signed URL, dynamic per row
            <img src={url} alt={label} className="max-h-[75vh] w-full rounded-sm object-contain" />
          )}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground hover:underline"
          >
            Open in new tab ↗
          </a>
        </DialogContent>
      </Dialog>
    </>
  );
}
