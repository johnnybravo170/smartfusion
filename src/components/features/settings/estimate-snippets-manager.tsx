'use client';

/**
 * CRUD manager for a tenant's estimate-snippet library. Inline-editable
 * rows for label / body / default toggle / display order.
 */

import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { EstimateSnippetRow } from '@/lib/db/queries/estimate-snippets';
import {
  createEstimateSnippetAction,
  deleteEstimateSnippetAction,
  updateEstimateSnippetAction,
} from '@/server/actions/estimate-snippets';

type Draft = {
  label: string;
  body: string;
  isDefault: boolean;
  displayOrder: number;
};

const EMPTY_DRAFT: Draft = { label: '', body: '', isDefault: false, displayOrder: 0 };

export function EstimateSnippetsManager({ snippets }: { snippets: EstimateSnippetRow[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creatingDraft, setCreatingDraft] = useState<Draft | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [pending, startTransition] = useTransition();

  function startCreate() {
    setCreatingDraft({ ...EMPTY_DRAFT, displayOrder: nextDisplayOrder(snippets) });
    setEditingId(null);
  }

  function startEdit(s: EstimateSnippetRow) {
    setEditingId(s.id);
    setEditDraft({
      label: s.label,
      body: s.body,
      isDefault: s.is_default,
      displayOrder: s.display_order,
    });
    setCreatingDraft(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setCreatingDraft(null);
  }

  function save(draft: Draft, id: string | null) {
    if (!draft.label.trim() || !draft.body.trim()) {
      toast.error('Label and body are required.');
      return;
    }
    startTransition(async () => {
      const res = id
        ? await updateEstimateSnippetAction(id, draft)
        : await createEstimateSnippetAction(draft);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(id ? 'Snippet updated.' : 'Snippet added.');
      setEditingId(null);
      setCreatingDraft(null);
    });
  }

  function handleDelete(id: string, label: string) {
    if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
    startTransition(async () => {
      const res = await deleteEstimateSnippetAction(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Snippet deleted.');
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        {creatingDraft ? null : (
          <Button type="button" size="sm" onClick={startCreate}>
            <Plus className="mr-1.5 size-3.5" />
            New snippet
          </Button>
        )}
      </div>

      {creatingDraft ? (
        <SnippetEditor
          draft={creatingDraft}
          onChange={setCreatingDraft}
          onSave={() => save(creatingDraft, null)}
          onCancel={cancelEdit}
          pending={pending}
          title="New snippet"
        />
      ) : null}

      <ul className="flex flex-col gap-3">
        {snippets.map((s) =>
          editingId === s.id ? (
            <li key={s.id}>
              <SnippetEditor
                draft={editDraft}
                onChange={setEditDraft}
                onSave={() => save(editDraft, s.id)}
                onCancel={cancelEdit}
                pending={pending}
                title="Edit snippet"
              />
            </li>
          ) : (
            <li key={s.id} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{s.label}</h3>
                    {s.is_default ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                        Default
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{s.body}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => startEdit(s)}
                    disabled={pending}
                    aria-label="Edit snippet"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => handleDelete(s.id, s.label)}
                    disabled={pending}
                    aria-label="Delete snippet"
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          ),
        )}
      </ul>

      {snippets.length === 0 && !creatingDraft ? (
        <p className="rounded-lg border border-dashed bg-card/60 p-6 text-center text-sm text-muted-foreground">
          No snippets yet. Create one to show up as a chip on the estimate editor.
        </p>
      ) : null}
    </div>
  );
}

function SnippetEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  pending,
  title,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div>
        <label
          htmlFor="snippet-label"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Label
        </label>
        <Input
          id="snippet-label"
          value={draft.label}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
          placeholder="e.g. Price includes"
          disabled={pending}
        />
      </div>
      <div>
        <label
          htmlFor="snippet-body"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Body
        </label>
        <Textarea
          id="snippet-body"
          rows={5}
          value={draft.body}
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
          placeholder="The paragraph that gets inserted when the chip is clicked."
          disabled={pending}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.isDefault}
            onChange={(e) => onChange({ ...draft, isDefault: e.target.checked })}
            disabled={pending}
          />
          Default — auto-insert on new estimates
        </label>
        <div>
          <label
            htmlFor="snippet-order"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Display order (lower = earlier)
          </label>
          <Input
            id="snippet-order"
            type="number"
            value={draft.displayOrder}
            onChange={(e) => onChange({ ...draft, displayOrder: Number(e.target.value) || 0 })}
            disabled={pending}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={pending}>
          {pending ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            'Save snippet'
          )}
        </Button>
      </div>
    </div>
  );
}

function nextDisplayOrder(snippets: EstimateSnippetRow[]): number {
  const max = snippets.reduce((m, s) => Math.max(m, s.display_order), 0);
  return max + 10;
}
