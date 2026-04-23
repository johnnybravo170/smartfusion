'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  archiveCardAction,
  assignCardAction,
  claimCardAction,
  moveCardAction,
  releaseCardAction,
  updateCardAction,
} from '../../actions';

const KANBAN_COLUMNS = ['backlog', 'todo', 'doing', 'blocked', 'done'] as const;
type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

type CardProps = {
  id: string;
  title: string;
  body: string;
  column_key: string;
  tags: string[];
  due_date: string;
  priority: number | null;
  assignee: string;
  suggested_agent: string;
  related_type: string;
  related_id: string;
  recurring_rule: string;
  blocked_by: string[];
  archived_at: string | null;
};

export function CardEditor({ slug, card }: { slug: string; card: CardProps }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [tags, setTags] = useState(card.tags.join(', '));
  const [dueDate, setDueDate] = useState(card.due_date);
  const [priority, setPriority] = useState<number | null>(card.priority);
  const [suggested, setSuggested] = useState(card.suggested_agent);
  const [relatedType, setRelatedType] = useState(card.related_type);
  const [relatedId, setRelatedId] = useState(card.related_id);
  const [recurringRule, setRecurringRule] = useState(card.recurring_rule);

  const [assigneeInput, setAssigneeInput] = useState(card.assignee);

  function onSaveFields() {
    startTransition(async () => {
      const r = await updateCardAction(card.id, slug, {
        title: title.trim(),
        body: body.trim() || null,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        due_date: dueDate || null,
        priority,
        suggested_agent: suggested.trim() || null,
        related_type: relatedType.trim() || null,
        related_id: relatedId.trim() || null,
        recurring_rule: recurringRule.trim() || null,
      });
      if (r.ok) {
        toast.success('Saved.');
        router.refresh();
      } else {
        toast.error(r.error);
      }
    });
  }

  function onMove(col: KanbanColumn) {
    startTransition(async () => {
      const r = await moveCardAction(card.id, slug, col);
      if (r.ok) {
        toast.success(`Moved to ${col}.`);
        router.refresh();
      } else {
        toast.error(r.error);
      }
    });
  }

  function onClaim() {
    startTransition(async () => {
      const r = await claimCardAction(card.id, slug);
      if (r.ok) {
        toast.success('Claimed.');
        router.refresh();
      } else {
        toast.error(r.error);
      }
    });
  }

  function onRelease() {
    startTransition(async () => {
      const r = await releaseCardAction(card.id, slug);
      if (r.ok) {
        toast.success('Released.');
        router.refresh();
      } else {
        toast.error(r.error);
      }
    });
  }

  function onAssign() {
    startTransition(async () => {
      const r = await assignCardAction(card.id, slug, assigneeInput.trim() || null);
      if (r.ok) {
        toast.success('Assigned.');
        router.refresh();
      } else {
        toast.error(r.error);
      }
    });
  }

  function onArchive() {
    if (!confirm('Archive this card?')) return;
    startTransition(async () => {
      const r = await archiveCardAction(card.id, slug);
      if (r.ok) {
        toast.success('Archived.');
        router.push(`/admin/kanban/${slug}`);
      } else {
        toast.error(r.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-lg font-semibold outline-none focus:ring-2 focus:ring-[var(--ring)]"
      />
      <textarea
        rows={6}
        value={body}
        placeholder="Body (markdown)"
        onChange={(e) => setBody(e.target.value)}
        className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-[var(--muted-foreground)]">
          Tags (comma-sep)
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs font-medium text-[var(--muted-foreground)]">
          Due date
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs font-medium text-[var(--muted-foreground)]">
          Priority
          <select
            value={priority ?? ''}
            onChange={(e) => setPriority(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-sm"
          >
            <option value="">None</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-[var(--muted-foreground)]">
          Suggested agent
          <input
            type="text"
            value={suggested}
            onChange={(e) => setSuggested(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs font-medium text-[var(--muted-foreground)]">
          Related type
          <input
            type="text"
            value={relatedType}
            placeholder="roadmap / idea / url / commit"
            onChange={(e) => setRelatedType(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs font-medium text-[var(--muted-foreground)]">
          Related id
          <input
            type="text"
            value={relatedId}
            onChange={(e) => setRelatedId(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs font-medium text-[var(--muted-foreground)] sm:col-span-2">
          Recurring rule
          <input
            type="text"
            placeholder="daily | weekly:mon | monthly:1"
            value={recurringRule}
            onChange={(e) => setRecurringRule(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-white px-2 py-1 text-sm"
          />
        </label>
      </div>

      {card.blocked_by.length > 0 ? (
        <div className="rounded-md border border-[var(--border)] p-3 text-xs">
          <div className="mb-1 font-semibold text-rose-600">Blocked by</div>
          <ul className="space-y-1">
            {card.blocked_by.map((b) => (
              <li key={b}>
                <a
                  className="font-mono text-xs hover:underline"
                  href={`/admin/kanban/${slug}/${b}`}
                >
                  {b}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onSaveFields}
          disabled={isPending}
          className="rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <section className="space-y-3 rounded-md border border-[var(--border)] p-4">
        <div>
          <div className="mb-1 text-xs font-medium text-[var(--muted-foreground)]">Column</div>
          <div className="flex flex-wrap gap-1">
            {KANBAN_COLUMNS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onMove(c)}
                disabled={isPending}
                className={`rounded px-2 py-1 text-xs ${
                  card.column_key === c
                    ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                    : 'border border-[var(--border)] hover:bg-[var(--muted)]'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-[var(--muted-foreground)]">
            Assignee {card.assignee ? `· currently @${card.assignee}` : '· unassigned'}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="name or agent"
              value={assigneeInput}
              onChange={(e) => setAssigneeInput(e.target.value)}
              className="flex-1 rounded border border-[var(--border)] bg-white px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={onAssign}
              disabled={isPending}
              className="rounded bg-[var(--primary)] px-2 py-1 text-xs font-medium text-[var(--primary-foreground)] disabled:opacity-50"
            >
              Assign
            </button>
            <button
              type="button"
              onClick={onClaim}
              disabled={isPending}
              className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--muted)]"
            >
              Claim
            </button>
            <button
              type="button"
              onClick={onRelease}
              disabled={isPending}
              className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--muted)]"
            >
              Release
            </button>
          </div>
        </div>

        {card.archived_at ? (
          <p className="text-xs text-[var(--muted-foreground)]">
            Archived {new Date(card.archived_at).toLocaleString()}.
          </p>
        ) : (
          <div className="flex justify-end border-t border-[var(--border)] pt-3">
            <button
              type="button"
              onClick={onArchive}
              disabled={isPending}
              className="text-xs text-[var(--destructive)] hover:underline"
            >
              Archive card
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
