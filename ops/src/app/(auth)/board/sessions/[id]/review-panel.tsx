'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { ActionItem, BoardDecision, BoardSession } from '@/lib/board/types';
import {
  acceptDecisionAction,
  editAndAcceptDecisionAction,
  rateSessionAction,
  rejectDecisionAction,
  rerunSessionAction,
} from '../../actions';
import { StarRating } from '../../star-rating';

type Mode = 'review' | 'edit' | 'reject' | 'rerun';

const BOARD_OPTIONS = ['ops', 'dev', 'marketing', 'research'] as const;

export function ReviewPanel({
  session,
  decision,
}: {
  session: BoardSession;
  decision: BoardDecision;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('review');
  const [rating, setRating] = useState<number | null>(session.overall_rating);
  const [notes, setNotes] = useState<string>(session.review_notes ?? '');
  const [savedNotes, setSavedNotes] = useState<string>(session.review_notes ?? '');
  const [editText, setEditText] = useState<string>(decision.decision_text);
  // Add a stable client-side `_key` to each editable action item so React
  // can track inserts/removes in the middle of the list without remounting
  // the whole array. Stripped before sending to the server.
  type EditItem = ActionItem & { _key: string };
  const [editItems, setEditItems] = useState<EditItem[]>(
    (decision.action_items.length > 0
      ? decision.action_items
      : [{ text: '', board_slug: 'ops' }]
    ).map((it, i) => ({ ...it, _key: `${decision.id}-${i}` })),
  );
  const nextKeyRef = useRef(editItems.length);
  const [rejectReason, setRejectReason] = useState('');
  const [revisedTopic, setRevisedTopic] = useState<string>(session.topic);
  const [isPending, startTransition] = useTransition();

  function persistRating(nextRating: number | null, nextNotes: string): void {
    startTransition(async () => {
      const r = await rateSessionAction({
        session_id: session.id,
        rating: nextRating,
        notes: nextNotes.trim() || null,
      });
      if (!r.ok) toast.error(r.error);
      else setSavedNotes(nextNotes);
    });
  }

  function onRatingChange(v: number | null): void {
    setRating(v);
    persistRating(v, notes);
  }

  function onNotesBlur(): void {
    if (notes === savedNotes) return;
    persistRating(rating, notes);
  }

  function onAccept(): void {
    if (!confirm('Accept the decision as-is? This spawns kanban cards and a decisions row.'))
      return;
    startTransition(async () => {
      const r = await acceptDecisionAction(session.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Accepted. ${r.kanban_card_count} kanban card(s) spawned.`);
      router.refresh();
    });
  }

  function onEditAccept(): void {
    const text = editText.trim();
    // Strip the synthetic _key before sending; the server schema rejects it.
    const items = editItems
      .map(({ _key: _drop, ...rest }) => ({ ...rest, text: rest.text.trim() }))
      .filter((i) => i.text);
    if (!text) {
      toast.error('Decision text is required');
      return;
    }
    startTransition(async () => {
      const r = await editAndAcceptDecisionAction({
        session_id: session.id,
        edited_decision_text: text,
        edited_action_items: items,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Edited and accepted. ${r.kanban_card_count} kanban card(s) spawned.`);
      router.refresh();
    });
  }

  function onReject(): void {
    if (!rejectReason.trim()) {
      toast.error('Reason required');
      return;
    }
    startTransition(async () => {
      const r = await rejectDecisionAction({
        session_id: session.id,
        reason: rejectReason.trim(),
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success('Decision rejected.');
      router.refresh();
    });
  }

  function onRerun(): void {
    const topic = revisedTopic.trim();
    if (!topic) {
      toast.error('Revised topic required');
      return;
    }
    if (topic === session.topic) {
      toast.error('Revise the topic first — same topic produces the same session.');
      return;
    }
    startTransition(async () => {
      const r = await rerunSessionAction({
        source_session_id: session.id,
        revised_topic: topic,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success('New session created. Open it and click Run.');
      router.push(`/board/sessions/${r.id}`);
    });
  }

  return (
    <section className="rounded-md border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-900 dark:bg-sky-950/30">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300">
          Review
        </h2>
        {mode !== 'review' ? (
          <button
            type="button"
            onClick={() => setMode('review')}
            className="text-xs text-[var(--muted-foreground)] hover:underline"
          >
            ← Back to actions
          </button>
        ) : null}
      </div>

      {mode === 'review' ? (
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium text-[var(--muted-foreground)]">Synthesis quality</p>
            <div className="mt-1">
              <StarRating value={rating} onChange={onRatingChange} ariaLabel="Synthesis rating" />
            </div>
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-[var(--muted-foreground)]">
              Notes (what was good, what was off, what you'd want different)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={onNotesBlur}
              rows={3}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
              placeholder="The chair over-indexed on cost; I wanted more on adoption risk."
            />
          </label>

          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              onClick={onAccept}
              disabled={isPending}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => setMode('edit')}
              disabled={isPending}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--foreground)]"
            >
              Edit & Accept
            </button>
            <button
              type="button"
              onClick={() => setMode('reject')}
              disabled={isPending}
              className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => setMode('rerun')}
              disabled={isPending}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--foreground)]"
            >
              Re-run with revised topic
            </button>
          </div>
          <p className="pt-1 text-xs text-[var(--muted-foreground)]">
            Accept fires action sinks (one row in <code>ops.decisions</code>, one kanban card per
            action item). Reject and Re-run do not.
          </p>
        </div>
      ) : null}

      {mode === 'edit' ? (
        <div className="space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-[var(--muted-foreground)]">
              Decision text
            </span>
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
            />
          </label>

          <div>
            <p className="text-xs font-medium text-[var(--muted-foreground)]">
              Action items (each becomes a kanban card)
            </p>
            <ul className="mt-1 space-y-2">
              {editItems.map((item, idx) => (
                <li key={item._key} className="flex items-start gap-2">
                  <textarea
                    value={item.text}
                    onChange={(e) => {
                      const next = [...editItems];
                      next[idx] = { ...next[idx], text: e.target.value };
                      setEditItems(next);
                    }}
                    rows={2}
                    placeholder="Action item — short, kanban-ready"
                    className="flex-1 rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
                  />
                  <select
                    value={item.board_slug ?? 'ops'}
                    onChange={(e) => {
                      const next = [...editItems];
                      next[idx] = { ...next[idx], board_slug: e.target.value };
                      setEditItems(next);
                    }}
                    className="rounded border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs"
                  >
                    {BOARD_OPTIONS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setEditItems(editItems.filter((_, i) => i !== idx))}
                    className="self-start rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted-foreground)] hover:border-red-300 hover:text-red-600"
                    aria-label="Remove action item"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() =>
                setEditItems([
                  ...editItems,
                  { text: '', board_slug: 'ops', _key: `new-${nextKeyRef.current++}` },
                ])
              }
              className="mt-2 rounded border border-dashed border-[var(--border)] px-2 py-1 text-xs text-[var(--muted-foreground)] hover:border-[var(--foreground)] hover:text-[var(--foreground)]"
            >
              + Add action item
            </button>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onEditAccept}
              disabled={isPending}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {isPending ? 'Saving...' : 'Save & Accept'}
            </button>
            <button
              type="button"
              onClick={() => setMode('review')}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'reject' ? (
        <div className="space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-[var(--muted-foreground)]">
              Why are you rejecting? (saved with the decision)
            </span>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
              placeholder="The chair missed the compliance angle entirely."
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onReject}
              disabled={isPending}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {isPending ? 'Rejecting...' : 'Reject decision'}
            </button>
            <button
              type="button"
              onClick={() => setMode('review')}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'rerun' ? (
        <div className="space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-[var(--muted-foreground)]">
              Revised topic (be specific about what to change)
            </span>
            <textarea
              value={revisedTopic}
              onChange={(e) => setRevisedTopic(e.target.value)}
              rows={6}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <p className="text-xs text-[var(--muted-foreground)]">
            A new session is created with the revised topic and the same advisors / model settings.
            The current session moves to <code>revised</code>.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRerun}
              disabled={isPending}
              className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {isPending ? 'Creating...' : 'Create revised session'}
            </button>
            <button
              type="button"
              onClick={() => setMode('review')}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
