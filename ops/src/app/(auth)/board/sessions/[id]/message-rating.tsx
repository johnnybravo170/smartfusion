'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { rateMessageAction } from '../../actions';
import { StarRating } from '../../star-rating';

/**
 * Inline rating widget for a single board_message. Persists on change,
 * debounce-free (small click cost). Notes save on blur.
 */
export function MessageRating({
  messageId,
  initialRating,
  initialNote,
}: {
  messageId: string;
  initialRating: number | null;
  initialNote: string | null;
}) {
  const [rating, setRating] = useState<number | null>(initialRating);
  const [note, setNote] = useState<string>(initialNote ?? '');
  const [savedNote, setSavedNote] = useState<string>(initialNote ?? '');
  const [isPending, startTransition] = useTransition();
  const [showNote, setShowNote] = useState(false);

  function persist(nextRating: number | null, nextNote: string): void {
    startTransition(async () => {
      const r = await rateMessageAction({
        message_id: messageId,
        rating: nextRating,
        note: nextNote.trim() || null,
      });
      if (!r.ok) toast.error(r.error);
      else setSavedNote(nextNote);
    });
  }

  function onRatingChange(v: number | null): void {
    setRating(v);
    persist(v, note);
  }

  function onNoteBlur(): void {
    if (note === savedNote) return;
    persist(rating, note);
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <StarRating
        value={rating}
        onChange={onRatingChange}
        size="sm"
        disabled={isPending}
        ariaLabel="Rate this message"
      />
      <button
        type="button"
        onClick={() => setShowNote((s) => !s)}
        className="text-xs text-[var(--muted-foreground)] hover:underline"
      >
        {showNote ? 'Hide note' : note ? 'Edit note' : '+ Add note'}
      </button>
      {showNote ? (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={onNoteBlur}
          placeholder="What worked or didn't on this advisor's reasoning?"
          className="min-w-[16rem] flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
        />
      ) : note ? (
        <span className="text-xs italic text-[var(--muted-foreground)]">"{note}"</span>
      ) : null}
    </div>
  );
}
