'use client';

/**
 * "Show on portal" affordance for a single photo. Lives in the photo card
 * overlay (operator surfaces only). Opens a popover with multi-select
 * portal tag chips and a client-visible toggle.
 *
 * Slice 2 of the Customer Portal & Home Record build. Bulk-tag UI is
 * out of scope for V1 — operator tags one photo at a time. The "On
 * portal" indicator dot on the trigger button shows at a glance which
 * photos are published.
 */

import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  PORTAL_PHOTO_TAGS,
  type PortalPhotoTag,
  portalPhotoTagLabels,
} from '@/lib/validators/portal-photo';
import {
  setPhotoPortalTagsAction,
  togglePhotoClientVisibleAction,
} from '@/server/actions/portal-photos';

type Props = {
  photoId: string;
  projectId: string;
  initialTags: string[];
  initialClientVisible: boolean;
};

export function PhotoPortalButton({
  photoId,
  projectId,
  initialTags,
  initialClientVisible,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<Set<PortalPhotoTag>>(
    () =>
      new Set(
        initialTags.filter((t): t is PortalPhotoTag =>
          (PORTAL_PHOTO_TAGS as readonly string[]).includes(t),
        ),
      ),
  );
  const [clientVisible, setClientVisible] = useState(initialClientVisible);
  const [pending, startTransition] = useTransition();

  const isPublished = tags.size > 0 && clientVisible;

  function toggleTag(tag: PortalPhotoTag) {
    const next = new Set(tags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    setTags(next);
    startTransition(async () => {
      const res = await setPhotoPortalTagsAction(photoId, Array.from(next), projectId);
      if (!res.ok) {
        toast.error(res.error);
        // Revert on error.
        setTags(tags);
      }
    });
  }

  function toggleVisible() {
    const next = !clientVisible;
    setClientVisible(next);
    startTransition(async () => {
      const res = await togglePhotoClientVisibleAction(photoId, next, projectId);
      if (!res.ok) {
        toast.error(res.error);
        setClientVisible(!next);
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={isPublished ? 'On portal — edit' : 'Show on portal'}
          title={isPublished ? 'On portal — edit' : 'Show on portal'}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:bg-background',
            isPublished && 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15',
          )}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : isPublished ? (
            <Eye className="size-3.5" aria-hidden />
          ) : (
            <EyeOff className="size-3.5" aria-hidden />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="end">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Show on customer portal</p>
            <p className="text-xs text-muted-foreground">
              Tag this photo so it appears on the homeowner&rsquo;s portal grouped by category.
            </p>
          </div>

          <div className="space-y-2">
            {PORTAL_PHOTO_TAGS.map((tag) => (
              <label
                key={tag}
                className="flex cursor-pointer items-center gap-2 text-sm"
                htmlFor={`portal-tag-${photoId}-${tag}`}
              >
                <Checkbox
                  id={`portal-tag-${photoId}-${tag}`}
                  checked={tags.has(tag)}
                  onCheckedChange={() => toggleTag(tag)}
                  disabled={pending}
                />
                <span>{portalPhotoTagLabels[tag]}</span>
                {tag === 'behind_wall' ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    Held back into its own section
                  </span>
                ) : null}
              </label>
            ))}
          </div>

          {tags.size > 0 ? (
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {clientVisible ? 'Visible to homeowner' : 'Hidden from homeowner'}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={toggleVisible}
                disabled={pending}
              >
                {clientVisible ? 'Hide' : 'Unhide'}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
