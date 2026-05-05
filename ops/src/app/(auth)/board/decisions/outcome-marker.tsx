'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { markDecisionOutcomeAction } from '../actions';

type Outcome = 'pending' | 'proven_right' | 'proven_wrong' | 'obsolete';

const OUTCOME_LABEL: Record<Outcome, string> = {
  pending: 'Pending',
  proven_right: 'Proven right',
  proven_wrong: 'Proven wrong',
  obsolete: 'Obsolete',
};

const OUTCOME_BUTTON: Record<Outcome, string> = {
  pending: 'border-[var(--border)] text-[var(--muted-foreground)]',
  proven_right:
    'border-emerald-300 bg-emerald-50/40 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300',
  proven_wrong:
    'border-red-300 bg-red-50/40 text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300',
  obsolete:
    'border-zinc-300 bg-zinc-50/40 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300',
};

const OUTCOME_BUTTON_ACTIVE: Record<Outcome, string> = {
  pending: 'border-[var(--foreground)] bg-[var(--muted)]',
  proven_right:
    'border-emerald-600 bg-emerald-100 text-emerald-800 dark:border-emerald-400 dark:bg-emerald-900/60 dark:text-emerald-200',
  proven_wrong:
    'border-red-600 bg-red-100 text-red-800 dark:border-red-400 dark:bg-red-900/60 dark:text-red-200',
  obsolete:
    'border-zinc-600 bg-zinc-100 text-zinc-800 dark:border-zinc-400 dark:bg-zinc-800 dark:text-zinc-100',
};

/**
 * Click an outcome button to set, click the active one to clear (back to
 * pending). Notes save on Save click. Auto-saves the outcome immediately
 * on change so a misclick is one click to undo.
 */
export function OutcomeMarker({
  decisionId,
  initialOutcome,
  initialNotes,
}: {
  decisionId: string;
  initialOutcome: Outcome;
  initialNotes: string | null;
}) {
  const [outcome, setOutcome] = useState<Outcome>(initialOutcome);
  const [notes, setNotes] = useState(initialNotes ?? '');
  const [savedNotes, setSavedNotes] = useState(initialNotes ?? '');
  const [isPending, startTransition] = useTransition();

  function persist(nextOutcome: Outcome, nextNotes: string): void {
    startTransition(async () => {
      const r = await markDecisionOutcomeAction({
        decision_id: decisionId,
        outcome: nextOutcome,
        notes: nextNotes.trim() || null,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setSavedNotes(nextNotes);
      if (nextOutcome !== outcome) {
        toast.success(`Marked: ${OUTCOME_LABEL[nextOutcome]}`);
      }
    });
  }

  function setOutcomeAndPersist(next: Outcome): void {
    // Click active button to clear (back to pending).
    const target = next === outcome ? 'pending' : next;
    setOutcome(target);
    persist(target, notes);
  }

  function onNotesBlur(): void {
    if (notes === savedNotes) return;
    persist(outcome, notes);
  }

  const options: Outcome[] = ['proven_right', 'proven_wrong', 'obsolete'];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const active = outcome === o;
          const className = active ? OUTCOME_BUTTON_ACTIVE[o] : OUTCOME_BUTTON[o];
          return (
            <button
              key={o}
              type="button"
              onClick={() => setOutcomeAndPersist(o)}
              disabled={isPending}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${className}`}
            >
              {active ? '✓ ' : ''}
              {OUTCOME_LABEL[o]}
            </button>
          );
        })}
        {outcome !== 'pending' ? (
          <button
            type="button"
            onClick={() => setOutcomeAndPersist('pending')}
            disabled={isPending}
            className="rounded-md border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            title="Clear outcome"
          >
            Clear
          </button>
        ) : null}
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={onNotesBlur}
        rows={2}
        placeholder="What signal turned out to be right or wrong? Optional but high-value — the Chair sees this next session."
        className="w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
      />
    </div>
  );
}
