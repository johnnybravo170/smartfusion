'use client';

import { Loader2, Sparkle } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { toggleFavoritePhotoAction } from '@/server/actions/photos';

export function PhotoFavoriteButton({
  photoId,
  isFavorite,
  jobType,
  suggestedJobTypes,
}: {
  photoId: string;
  isFavorite: boolean;
  jobType: string | null;
  suggestedJobTypes: string[];
}) {
  const [open, setOpen] = useState(false);
  const [fav, setFav] = useState(isFavorite);
  const [type, setType] = useState(jobType ?? '');
  const [pending, start] = useTransition();

  function save(nextFav: boolean, nextType: string) {
    start(async () => {
      const res = await toggleFavoritePhotoAction({
        id: photoId,
        is_favorite: nextFav,
        job_type: nextType,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setFav(nextFav);
      setType(nextType.trim());
      toast.success(nextFav ? 'Added to showcase.' : 'Removed from showcase.');
      setOpen(false);
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={fav ? 'Edit showcase tag' : 'Mark as showcase favourite'}
          className={cn(
            'flex size-7 items-center justify-center rounded-full border bg-background/90 shadow-sm transition-colors',
            fav
              ? 'border-amber-300 text-amber-500 hover:bg-amber-50'
              : 'border-muted text-muted-foreground hover:text-amber-500 hover:border-amber-300',
          )}
        >
          <Sparkle className={cn('size-4', fav && 'fill-amber-400')} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="job-type" className="text-xs">
            Job type (shows on showcase)
          </Label>
          <Input
            id="job-type"
            list={`job-types-${photoId}`}
            placeholder="Kitchen, Deck, Exterior wash…"
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
          <datalist id={`job-types-${photoId}`}>
            {suggestedJobTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>

        <div className="flex gap-2">
          {fav ? (
            <>
              <Button
                size="sm"
                className="flex-1"
                disabled={pending}
                onClick={() => save(true, type)}
              >
                {pending ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => save(false, '')}
              >
                Remove
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              className="flex-1"
              disabled={pending}
              onClick={() => save(true, type)}
            >
              {pending ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
              Add to showcase
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
